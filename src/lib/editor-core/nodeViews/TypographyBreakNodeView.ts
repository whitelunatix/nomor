import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from 'prosemirror-view';
import { getTypographyOptions, subscribeTypography } from '../../typography/options';
import { softBreakText } from '../../typography/rules';
import { projectInlineSourceWithMapping } from '../InlineSourceCodec';
const projections = new WeakMap<
  ProseMirrorNode,
  ReturnType<typeof projectInlineSourceWithMapping>
>();
const views = new WeakMap<EditorView, Set<TypographyBreakNodeView>>();
const projectionKey = new PluginKey<{ enabled: boolean; decorations: DecorationSet }>(
  'nomo-typography-breaks',
);
export const isTypographyBreakTransaction = (transaction: Transaction) =>
  transaction.getMeta(projectionKey) !== undefined;
export const typographyBreakProjectionEnabled = (state: EditorState) =>
  projectionKey.getState(state)?.enabled ?? getTypographyOptions().enabled;

/** Recreate only soft-break NodeViews when their root changes between BR and span. */
export function typographyBreaksPlugin() {
  return new Plugin({
    key: projectionKey,
    state: {
      init: () => ({ enabled: getTypographyOptions().enabled, decorations: DecorationSet.empty }),
      apply(tr, previous) {
        const enabled = (tr.getMeta(projectionKey) as boolean | undefined) ?? previous.enabled;
        if (enabled !== previous.enabled) {
          const decorations: Decoration[] = [];
          // Only an explicit setting change scans breaks; typing just maps this set.
          tr.doc.descendants((node, pos) => {
            if (node.type.name === 'hard_break' && node.attrs.soft)
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  'data-nomo-break-projection': String(enabled),
                }),
              );
          });
          return { enabled, decorations: DecorationSet.create(tr.doc, decorations) };
        }
        return tr.docChanged
          ? { enabled, decorations: previous.decorations.map(tr.mapping, tr.doc) }
          : previous;
      },
    },
    props: {
      decorations: (state) => projectionKey.getState(state)?.decorations,
      nodeViews: {
        hard_break: (node, view, getPos) => new TypographyBreakNodeView(node, view, getPos),
      },
    },
    view(view) {
      let destroyed = false;
      let pending = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        if (destroyed) return;
        if (view.composing) {
          pending = true;
          return;
        }
        pending = false;
        const enabled = getTypographyOptions().enabled;
        if (projectionKey.getState(view.state)?.enabled !== enabled)
          view.dispatch(view.state.tr.setMeta(projectionKey, enabled).setMeta('addToHistory', false));
        refreshTypographyBreaks(view);
      };
      const compositionEnd = () => {
        if (!pending) return;
        clearTimeout(timer);
        // Let ProseMirror flush the final IME text before replacing a break root.
        timer = setTimeout(refresh, 0);
      };
      const unsubscribe = subscribeTypography(refresh);
      view.dom.addEventListener('compositionend', compositionEnd);
      // A cached EditorState may have been detached while the global option changed.
      queueMicrotask(refresh);
      return {
        destroy() {
          destroyed = true;
          clearTimeout(timer);
          unsubscribe();
          view.dom.removeEventListener('compositionend', compositionEnd);
        },
      };
    },
  });
}

function projectsSoftBreak(node: ProseMirrorNode, view: EditorView) {
  return node.attrs.soft && typographyBreakProjectionEnabled(view.state);
}

export function refreshTypographyBreaks(view: EditorView) {
  for (const item of views.get(view) ?? []) item.render();
}

/** Retains the source hard_break node while changing only its visual projection. */
export class TypographyBreakNodeView implements NodeView {
  dom: HTMLElement;
  constructor(
    private node: ProseMirrorNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    // A noneditable span containing BR loses its BR during Chromium composition.
    this.dom = document.createElement(projectsSoftBreak(node, view) ? 'span' : 'br');
    this.dom.dataset.nomoBreak = node.attrs.soft ? 'soft' : 'hard';
    if (!views.has(view)) views.set(view, new Set());
    views.get(view)!.add(this);
    this.render();
  }
  update(node: ProseMirrorNode) {
    if (
      node.type !== this.node.type ||
      Boolean(projectsSoftBreak(node, this.view)) !== (this.dom.nodeName === 'SPAN')
    ) return false;
    this.node = node;
    this.render();
    return true;
  }
  render() {
    if (this.view.composing) return;
    this.dom.dataset.nomoBreak = this.node.attrs.soft ? 'soft' : 'hard';
    if (this.dom.nodeName === 'SPAN') {
      const pos = this.getPos();
      if (pos === undefined) return;
      const $pos = this.view.state.doc.resolve(pos);
      let projection = projections.get($pos.parent);
      if (!projection) {
        projection = projectInlineSourceWithMapping($pos.parent);
        projections.set($pos.parent, projection);
      }
      // Read visible source boundaries; atoms and other breaks still stop the neighboring text.
      const leafText = (node: ProseMirrorNode) =>
        node.type.name === 'hard_break' ? '\n' : '\ufffc';
      const before = projection.doc.textBetween(
        0,
        projection.mapPosition($pos.parentOffset),
        '',
        leafText,
      );
      const after = projection.doc.textBetween(
        projection.mapPosition($pos.parentOffset + this.node.nodeSize),
        projection.doc.content.size,
        '',
        leafText,
      );
      const text = softBreakText(before, after);
      if (this.dom.textContent !== text || this.dom.childElementCount) this.dom.textContent = text;
    }
  }
  ignoreMutation() {
    return true;
  }
  destroy() {
    views.get(this.view)?.delete(this);
  }
}
