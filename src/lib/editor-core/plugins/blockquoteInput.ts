import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { wrapIn } from 'prosemirror-commands';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from '../schema';

type CompositionCleanupTarget = {
  id: number;
  phase: 'armed' | 'composing' | 'pending';
  quotePos: number;
  quoteEnd: number;
  paragraphPos: number;
  from: number;
  to: number;
  compositionId: number | null;
};

type InputContext = {
  ignoreInputUntilNextTask: boolean;
  latestCommittedCompositionText: string;
  timers: ReturnType<typeof setTimeout>[];
  destroyed: boolean;
};

const blockquoteInputKey = new PluginKey<CompositionCleanupTarget | null>('blockquoteInput');

export function blockquoteInputPlugin(): Plugin {
  const contexts = new WeakMap<EditorView, InputContext>();
  let nextCleanupId = 0;

  function contextFor(view: EditorView): InputContext {
    let context = contexts.get(view);
    if (!context) {
      context = {
        ignoreInputUntilNextTask: false,
        latestCommittedCompositionText: '',
        timers: [],
        destroyed: false,
      };
      contexts.set(view, context);
    }
    return context;
  }

  function clearTimers(context: InputContext): void {
    for (const timer of context.timers) clearTimeout(timer);
    context.timers = [];
    context.ignoreInputUntilNextTask = false;
  }

  function rememberCommittedCompositionText(context: InputContext, event: Event): void {
    const text = readEventData(event);
    if (text && containsHan(text)) context.latestCommittedCompositionText = text;
  }

  function convertShortcut(view: EditorView, event: Event): boolean {
    const tr = createBlockquoteInputTransaction(view.state);
    if (!tr) return false;

    const context = contextFor(view);
    clearTimers(context);
    context.latestCommittedCompositionText = '';
    event.preventDefault();
    const target = captureEmptyBlockquoteInput(tr, ++nextCleanupId);
    view.dispatch(tr.setMeta(blockquoteInputKey, target).scrollIntoView());
    return true;
  }

  return new Plugin<CompositionCleanupTarget | null>({
    key: blockquoteInputKey,
    state: {
      init: () => null,
      apply: mapCompositionCleanupTarget,
    },
    view(view) {
      const context = contextFor(view);
      return {
        destroy() {
          context.destroyed = true;
          clearTimers(context);
          contexts.delete(view);
        },
      };
    },
    props: {
      handleDOMEvents: {
        keydown(view, event) {
          const context = contextFor(view);
          if (!view.editable || context.ignoreInputUntilNextTask || !isPlainSpaceKey(event)) {
            return false;
          }
          if (view.composing || event.isComposing) return false;
          return convertShortcut(view, event);
        },
        beforeinput(view, event) {
          const context = contextFor(view);
          rememberCommittedCompositionText(context, event);
          if (!view.editable || context.ignoreInputUntilNextTask || !isPlainSpaceInput(event)) {
            return false;
          }
          if (view.composing || event.isComposing) return false;
          return convertShortcut(view, event);
        },
        compositionstart(view) {
          const context = contextFor(view);
          clearTimers(context);
          context.latestCommittedCompositionText = '';
          const target = blockquoteInputKey.getState(view.state);
          const current = captureEmptyBlockquoteInput(view.state, 0);
          const activeTarget =
            view.editable &&
            target?.phase === 'armed' &&
            current?.quotePos === target.quotePos &&
            current.paragraphPos === target.paragraphPos
              ? { ...target, phase: 'composing' as const }
              : null;
          view.dispatch(view.state.tr.setMeta(blockquoteInputKey, activeTarget));
          return false;
        },
        compositionupdate(view, event) {
          rememberCommittedCompositionText(contextFor(view), event);
          return false;
        },
        compositionend(view, event) {
          const context = contextFor(view);
          clearTimers(context);
          rememberCommittedCompositionText(context, event);
          const target = blockquoteInputKey.getState(view.state);
          const cleanupId = target?.phase === 'composing' ? target.id : null;
          const finalText = context.latestCommittedCompositionText;
          if (cleanupId !== null && target) {
            view.dispatch(view.state.tr.setMeta(blockquoteInputKey, { ...target, phase: 'pending' }));
          }
          context.ignoreInputUntilNextTask = true;
          context.timers.push(
            setTimeout(() => {
              if (!context.destroyed && cleanupId !== null) {
                cleanupDuplicatedCompositionText(view, cleanupId, finalText);
              }
              context.ignoreInputUntilNextTask = false;
            }, 0),
            setTimeout(() => {
              if (context.destroyed || view.isDestroyed) return;
              if (cleanupId !== null) cleanupDuplicatedCompositionText(view, cleanupId, finalText);
              if (blockquoteInputKey.getState(view.state)?.id === cleanupId) {
                view.dispatch(view.state.tr.setMeta(blockquoteInputKey, null));
              }
              context.latestCommittedCompositionText = '';
            }, 120),
          );
          return false;
        },
      },
    },
  });
}

function mapCompositionCleanupTarget(
  tr: Transaction,
  target: CompositionCleanupTarget | null,
): CompositionCleanupTarget | null {
  const replacement = tr.getMeta(blockquoteInputKey);
  if (replacement !== undefined) return replacement;
  if (!target || !tr.docChanged) return target;

  const compositionId = tr.getMeta('composition');
  const ownComposition =
    typeof compositionId === 'number' &&
    (target.compositionId === null || compositionId === target.compositionId);

  // compositionend 后的新编辑不属于原组字范围；取消清理以保留后来输入。
  if (target.phase === 'pending' && !ownComposition) {
    let from = target.from;
    let to = target.to;
    let changedInput = false;
    for (const map of tr.mapping.maps) {
      map.forEach((start, end) => {
        if (start <= to && end >= from) changedInput = true;
      });
      from = map.map(from, 1);
      to = map.map(to, -1);
    }
    if (changedInput) return null;
  }

  const quotePos = tr.mapping.mapResult(target.quotePos, 1);
  const quoteEnd = tr.mapping.mapResult(target.quoteEnd, -1);
  const paragraphPos = tr.mapping.mapResult(target.paragraphPos, 1);
  if (quotePos.deleted || quoteEnd.deleted || paragraphPos.deleted) return null;
  const quote = tr.doc.nodeAt(quotePos.pos);
  if (
    quote?.type !== schema.nodes.blockquote ||
    quotePos.pos + quote.nodeSize !== quoteEnd.pos ||
    tr.doc.nodeAt(paragraphPos.pos)?.type !== schema.nodes.paragraph
  ) {
    return null;
  }

  const expanding = target.phase !== 'pending' || ownComposition;
  const from = tr.mapping.map(target.from, expanding ? -1 : 1);
  const to = tr.mapping.map(target.to, expanding ? 1 : -1);
  if (from > to || from <= quotePos.pos || to >= quoteEnd.pos) return null;
  return {
    ...target,
    quotePos: quotePos.pos,
    quoteEnd: quoteEnd.pos,
    paragraphPos: paragraphPos.pos,
    from,
    to,
    compositionId: ownComposition ? compositionId : target.compositionId,
  };
}

function isPlainSpaceInput(event: Event): event is InputEvent {
  if (typeof InputEvent === 'undefined' || !(event instanceof InputEvent)) return false;
  return event.inputType === 'insertText' && event.data === ' ';
}

function isPlainSpaceKey(event: Event): event is KeyboardEvent {
  if (typeof KeyboardEvent === 'undefined' || !(event instanceof KeyboardEvent)) return false;
  return (
    (event.key === ' ' || event.key === 'Spacebar') &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function readEventData(event: Event): string {
  return 'data' in event && typeof event.data === 'string' ? event.data : '';
}

function containsHan(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

function captureEmptyBlockquoteInput(
  state: Pick<EditorState, 'doc' | 'selection'>,
  id: number,
): CompositionCleanupTarget | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;
  const { $from } = selection;
  if ($from.parent.type !== schema.nodes.paragraph || $from.parent.content.size !== 0) {
    return null;
  }
  const depth = $from.depth - 1;
  if (depth < 1 || $from.node(depth).type !== schema.nodes.blockquote) return null;
  return {
    id,
    phase: 'armed',
    quotePos: $from.before(depth),
    quoteEnd: $from.after(depth),
    paragraphPos: $from.before(),
    from: $from.pos,
    to: $from.pos,
    compositionId: null,
  };
}

export function createBlockquoteInputTransaction(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;

  const { $from } = selection;
  if ($from.parent.type !== schema.nodes.paragraph) return null;
  if ($from.parentOffset !== $from.parent.content.size) return null;
  const shortcutText = $from.parent.textBetween(0, $from.parentOffset);
  if (!/^\s{0,3}>$/.test(shortcutText)) return null;

  const tr = state.tr.delete($from.start(), $from.pos);
  let capturedTr: Transaction | null = null;
  const handled = wrapIn(schema.nodes.blockquote)(state.apply(tr), (nextTr) => {
    capturedTr = nextTr;
  });
  const wrappedTr = capturedTr as Transaction | null;
  if (!handled || !wrappedTr) return null;

  for (const step of wrappedTr.steps) {
    tr.step(step);
  }
  tr.setSelection(
    TextSelection.near(tr.doc.resolve(clampDocPosition(tr.doc, wrappedTr.selection.anchor))),
  );
  return tr;
}

function clampDocPosition(doc: ProseMirrorNode, position: number): number {
  return Math.max(0, Math.min(position, doc.content.size));
}

function cleanupDuplicatedCompositionText(
  view: EditorView,
  cleanupId: number,
  finalText: string,
): void {
  if (view.isDestroyed || !view.editable) return;
  const input = blockquoteInputKey.getState(view.state);
  if (!input || input.id !== cleanupId || input.phase !== 'pending') return;
  const quote = view.state.doc.nodeAt(input.quotePos);
  if (quote?.type !== schema.nodes.blockquote || input.quotePos + quote.nodeSize !== input.quoteEnd) {
    return;
  }

  // 只查看原空段落产生的范围，不读取后来选区，也不全文搜索其他引用。
  let target: { node: ProseMirrorNode; index: number; pos: number; text: string; start: number } | null = null;
  let firstIndex = -1;
  quote.forEach((node, offset, index) => {
    const pos = input.quotePos + 1 + offset;
    if (pos === input.paragraphPos) firstIndex = index;
    if (target || node.type !== schema.nodes.paragraph) return;
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    const start = finalText ? text.lastIndexOf(finalText) : text.search(/[\u3400-\u9fff\uf900-\ufaff]/);
    const matchEnd = pos + 1 + start + (finalText.length || 1);
    if (start >= 0 && pos + 1 + start >= input.from && matchEnd <= input.to) {
      target = { node, index, pos, text, start };
    }
  });
  const committed = target as { node: ProseMirrorNode; index: number; pos: number; text: string; start: number } | null;
  if (!committed || firstIndex < 0 || committed.index < firstIndex) return;

  const tr = view.state.tr;
  if (committed.index > firstIndex) {
    let sawCompositionText = false;
    let paragraphPos = input.paragraphPos;
    for (let index = firstIndex; index < committed.index; index += 1) {
      const node = quote.child(index);
      const text = node.textBetween(0, node.content.size, '', '\ufffc');
      if (
        node.type !== schema.nodes.paragraph ||
        paragraphPos + 1 < input.from ||
        paragraphPos + 1 + node.content.size > input.to
      ) {
        return;
      }
      if (isAsciiCompositionText(text)) sawCompositionText = true;
      else if (node.content.size !== 0) return;
      paragraphPos += node.nodeSize;
    }
    if (!sawCompositionText) return;
    tr.delete(input.paragraphPos, committed.pos);
  } else {
    if (committed.start <= 0) return;
    const prefix = committed.text.slice(0, committed.start);
    if (!isAsciiCompositionText(prefix) || committed.pos + 1 < input.from) return;
    tr.delete(committed.pos + 1, committed.pos + 1 + prefix.length);
  }
  view.dispatch(tr.setMeta(blockquoteInputKey, null));
}

function isAsciiCompositionText(text: string): boolean {
  return /^[\x20-\x7e]+$/.test(text) && /[A-Za-z]/.test(text);
}
