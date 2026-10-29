import { closeHistory } from 'prosemirror-history';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { t } from '../../../app/i18n';
import {
  registerActiveEdit,
  unregisterActiveEdit,
  isActiveEditComposing,
  commitActiveEdit,
} from '../nodeViews/activeEditRegistry';
import { createInlineMathInput, createInlineMathPreview } from '../nodeViews/inlineMathUi';
import { getMathRenderer } from '../renderers';

interface Draft {
  from: number;
  to: number;
  anchor: number;
  head: number;
  initial: string;
  token: object;
}

export const mathInlineDraftKey = new PluginKey<Draft | null>('mathInlineDraft');

/** Only a single text container can become an inline formula; never flatten objects or blocks. */
export function canInsertMathInline(state: EditorState): boolean {
  const selection = state.selection;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to, from, to } = selection;
  if (!$from.sameParent($to) || !['paragraph', 'heading'].includes($from.parent.type.name))
    return false;
  let textOnly = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  return textOnly;
}

/** The document remains untouched, including a quick-insert trigger, until confirmation. */
export function startMathInlineDraft(
  view: EditorView,
  range?: { from: number; to: number },
): boolean {
  if (!view.editable || isActiveEditComposing(view) || !mathInlineDraftKey.get(view.state))
    return false;
  if (mathInlineDraftKey.getState(view.state)) return false;
  commitActiveEdit(view, true);
  const selection = range
    ? TextSelection.create(view.state.doc, range.from, range.to)
    : view.state.selection;
  const candidate = view.state.apply(view.state.tr.setSelection(selection));
  if (!canInsertMathInline(candidate)) return false;
  const { from, to } = selection;
  const { anchor, head } = view.state.selection;
  const draft: Draft = {
    from,
    to,
    anchor,
    head,
    initial: range ? '' : view.state.doc.textBetween(from, to),
    token: {},
  };
  view.dispatch(view.state.tr.setMeta(mathInlineDraftKey, draft).setMeta('addToHistory', false));
  return true;
}

export function cancelMathInlineDraft(view: EditorView): void {
  if (mathInlineDraftKey.getState(view.state)) {
    view.dispatch(view.state.tr.setMeta(mathInlineDraftKey, null).setMeta('addToHistory', false));
  }
}

function mapDraft(draft: Draft, tr: Transaction): Draft | null {
  let { from, to, anchor, head } = draft;
  for (const map of tr.mapping.maps) {
    let touched = false;
    map.forEach((start, end) => {
      if (
        from === to
          ? start <= from && end >= from
          : (start < to && end > from) || (start === end && start > from && start < to)
      )
        touched = true;
    });
    if (touched) return null;
    const mappedFrom = map.mapResult(from, 1);
    const mappedTo = map.mapResult(to, from === to ? 1 : -1);
    if (mappedFrom.deletedAcross || mappedTo.deletedAcross) return null;
    const forward = anchor <= head;
    const empty = anchor === head;
    anchor = map.map(anchor, forward ? 1 : -1);
    head = map.map(head, empty || !forward ? 1 : -1);
    from = mappedFrom.pos;
    to = mappedTo.pos;
  }
  // Mark-only changes also invalidate the saved target rather than overwrite external formatting.
  if (!tr.before.slice(draft.from, draft.to).eq(tr.doc.slice(from, to))) return null;
  const $from = tr.doc.resolve(from);
  if (
    !$from.sameParent(tr.doc.resolve(to)) ||
    !['paragraph', 'heading'].includes($from.parent.type.name)
  )
    return null;
  return { ...draft, from, to, anchor, head };
}

export function mathInlineDraftPlugin(): Plugin {
  let editor: DraftEditor | null = null;
  return new Plugin<Draft | null>({
    key: mathInlineDraftKey,
    state: {
      init: () => null,
      apply(tr, draft) {
        const action = tr.getMeta(mathInlineDraftKey) as Draft | null | undefined;
        if (action !== undefined) return action;
        return draft && tr.docChanged ? mapDraft(draft, tr) : draft;
      },
    },
    props: {
      decorations(state) {
        const draft = mathInlineDraftKey.getState(state);
        if (!draft) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(
            draft.from,
            (view) => {
              editor?.destroy();
              editor = new DraftEditor(view, draft);
              return editor.dom;
            },
            { side: -1, key: 'inline-math-draft', stopEvent: () => true, ignoreSelection: true },
          ),
        ]);
      },
    },
    view: () => ({
      update(view) {
        if (!mathInlineDraftKey.getState(view.state) || !view.editable) {
          editor?.destroy();
          editor = null;
        } else editor?.position();
      },
      destroy() {
        editor?.destroy();
        editor = null;
      },
    }),
  });
}

/** A view-owned input buffer: no temporary formula node, copied document, or undo entry. */
class DraftEditor {
  readonly dom: HTMLSpanElement;
  private readonly input: HTMLInputElement;
  private readonly card: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly win: Window;
  private destroyed = false;
  private composing = false;
  private waiters = new Set<() => void>();
  private deferred: { save: boolean; focus: boolean } | null = null;
  private frame: number | null = null;
  private timer: number | null = null;
  private renderId = 0;
  private exit = () => this.finish(true, false);

  constructor(
    private readonly view: EditorView,
    private readonly draft: Draft,
  ) {
    const doc = view.dom.ownerDocument;
    this.win = doc.defaultView!;
    this.dom = doc.createElement('span');
    this.dom.className = 'math-inline is-editing math-inline-draft';
    this.dom.contentEditable = 'false';
    this.input = createInlineMathInput(doc, draft.initial);
    this.input.setAttribute('aria-label', t.insertMathInline());
    this.dom.append(this.input);
    const preview = createInlineMathPreview(doc);
    this.card = preview.card;
    this.content = preview.content;
    this.card.style.visibility = 'hidden';
    this.card.addEventListener('mousedown', (event) => event.preventDefault());
    doc.body.append(this.card);
    this.win.addEventListener('scroll', this.position, true);
    this.win.addEventListener('resize', this.position);
    this.input.addEventListener('input', this.refresh);
    this.input.addEventListener('blur', () => this.finish(true, false));
    this.input.addEventListener('keydown', (event) => {
      if (this.composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.finish(event.key === 'Enter', true);
      }
    });
    this.input.addEventListener('compositionstart', () => {
      if (this.timer !== null) this.win.clearTimeout(this.timer);
      this.timer = null;
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.timer = this.win.setTimeout(() => {
        this.timer = null;
        this.composing = false;
        this.resolveWaiters();
        const deferred = this.deferred;
        this.deferred = null;
        if (deferred) this.finish(deferred.save, deferred.focus);
      }, 0);
    });
    // The previous active edit was settled before the draft transaction.
    registerActiveEdit(view, this.exit, undefined, {
      isComposing: () => this.composing,
      waitForCompositionEnd: () =>
        this.composing
          ? new Promise<void>((resolve) => this.waiters.add(resolve))
          : Promise.resolve(),
    });
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      if (this.destroyed || !view.editable) return;
      this.input.focus({ preventScroll: true });
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
      this.position();
      this.card.style.visibility = '';
    });
    this.refresh();
  }

  private finish(save: boolean, focus: boolean): void {
    if (this.destroyed) return;
    if (!this.view.editable || this.view.isDestroyed) {
      this.destroy();
      return;
    }
    if (this.composing) {
      this.deferred = { save, focus };
      return;
    }
    const current = mathInlineDraftKey.getState(this.view.state);
    if (!current || current.token !== this.draft.token) {
      this.destroy();
      return;
    }
    const tex = this.input.value;
    const commit = save && Boolean(tex.trim());
    let tr = this.view.state.tr.setMeta(mathInlineDraftKey, null);
    tr.setSelection(TextSelection.create(tr.doc, current.anchor, current.head));
    if (commit) {
      // Preserve the original selection in history, including reverse selections.
      this.view.dispatch(
        this.view.state.tr.setSelection(tr.selection).setMeta('addToHistory', false),
      );
      tr = closeHistory(this.view.state.tr)
        .setMeta(mathInlineDraftKey, null)
        .replaceWith(
          current.from,
          current.to,
          this.view.state.schema.nodes.math_inline.create({ tex }),
        );
      tr.setSelection(TextSelection.create(tr.doc, current.from + 1));
    } else tr.setMeta('addToHistory', false);
    this.destroy();
    this.view.dispatch(tr);
    if (commit) this.view.dispatch(closeHistory(this.view.state.tr).setMeta('addToHistory', false));
    if (focus) this.view.focus();
  }

  position = (): void => {
    if (this.destroyed) return;
    const rect = this.input.getBoundingClientRect();
    this.card.style.display = rect.bottom < 0 || rect.top >= this.win.innerHeight ? 'none' : '';
    this.card.style.top = `${rect.bottom + 4}px`;
    this.card.style.left = `${Math.max(8, rect.left)}px`;
    this.card.style.maxWidth = `${Math.max(100, Math.min(this.win.innerWidth - rect.left - 16, 600))}px`;
  };

  private refresh = (): void => {
    if (this.destroyed) return;
    this.input.style.width = `${Math.max(4, this.input.value.length + 1)}ch`;
    this.position();
    void this.preview();
  };

  private async preview(): Promise<void> {
    const id = ++this.renderId;
    const tex = this.input.value.trim();
    if (!tex) {
      this.content.textContent = '';
      return;
    }
    try {
      const renderer = getMathRenderer();
      if (!renderer) {
        this.content.textContent = 'Math renderer unavailable';
        return;
      }
      const result = await renderer.render(tex, { displayMode: false });
      if (this.destroyed || id !== this.renderId) return;
      if (result.error) this.content.textContent = result.error;
      else this.content.innerHTML = result.html;
    } catch {
      if (!this.destroyed && id === this.renderId) this.content.textContent = 'KaTeX error';
    }
  }

  private resolveWaiters(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderId++;
    this.composing = false;
    this.deferred = null;
    this.resolveWaiters();
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    unregisterActiveEdit(this.view, this.exit);
    this.win.removeEventListener('scroll', this.position, true);
    this.win.removeEventListener('resize', this.position);
    this.card.remove();
  }
}
