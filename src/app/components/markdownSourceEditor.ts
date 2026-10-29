import type {
  BlockAlignmentAnchor,
  BlockNaturalGeometry,
} from '../services/markdownBlockAlignment';
import { history } from '@codemirror/commands';
import { EditorState, StateEffect, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

let sourceEditorTheme: ReturnType<typeof EditorView.theme> | undefined;

/** style-mod 在文档级保留已挂载规则；同一静态主题只创建一次，首次使用源码时再初始化。 */
export function getSourceEditorTheme() {
  return sourceEditorTheme ??= EditorView.theme({
    '&': { height: '100%', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto', fontFamily: 'var(--md-editor-font-mono)', fontSize: '14px', lineHeight: '1.75',
    },
    '.cm-content': {
      minHeight: 'var(--md-editor-content-min-height, 0px)', padding: '0', caretColor: 'var(--md-editor-fg)',
    },
    '.cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: 'var(--md-editor-fg)' },
    '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--md-editor-accent) 22%, transparent)' },
  });
}

/** 只保留文档、选区与撤销字段，不能把组件回调、布局 widget 或视图插件带入标签缓存。 */
export function detachSourceEditorState(state: EditorState): EditorState {
  return state.update({
    effects: StateEffect.reconfigure.of(history()),
    annotations: Transaction.addToHistory.of(false),
  }).state;
}

/** 仅在本窗口按文档缓存，不序列化到工作区或跨窗口移交。 */
export interface MarkdownSourceRuntimeState {
  readonly documentId: string;
  readonly state: EditorState;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly contentRevision: number;
}

export interface MarkdownSourceSelection {
  from: number;
  to: number;
  anchor?: number;
  head?: number;
}

export interface MarkdownSourceSelectionSnapshot extends MarkdownSourceSelection {
  documentId: string;
  contentRevision: number;
}

/**
 * 序列化可能同时规范化多处 HTML、列表和表格，不能将首尾差异之间的正文整段替换。
 * 先保留相同的行，再细分变化行中的字符；所有区间共用旧文档坐标，单次事务提交。
 */
export function getSourceTextChanges(previous: string, next: string) {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const split = (
    from: number,
    to: number,
    insertFrom: number,
    insertTo: number,
    lines: boolean,
  ) => {
    while (from < to && insertFrom < insertTo && previous[from] === next[insertFrom]) {
      from++;
      insertFrom++;
    }
    if (from > 0 && /[\uD800-\uDBFF]/.test(previous[from - 1])) {
      from--;
      insertFrom--;
    }
    while (to > from && insertTo > insertFrom && previous[to - 1] === next[insertTo - 1]) {
      to--;
      insertTo--;
    }
    if (to < previous.length && /[\uDC00-\uDFFF]/.test(previous[to])) {
      to++;
      insertTo++;
    }
    if (from === to && insertFrom === insertTo) return;
    if (from === to || insertFrom === insertTo) {
      changes.push({ from, to, insert: next.slice(insertFrom, insertTo) });
      return;
    }
    const tokenize = (text: string) =>
      lines ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []) : Array.from(text);
    const before = tokenize(previous.slice(from, to));
    const after = tokenize(next.slice(insertFrom, insertTo));
    const matches = matchingTokens(before, after);
    // 大规模重写时限制 diff 的工作量；只替换当前无法细分的区间，已匹配行仍然保留。
    if (!matches || !matches.length) {
      if (lines) split(from, to, insertFrom, insertTo, false);
      else changes.push({ from, to, insert: next.slice(insertFrom, insertTo) });
      return;
    }
    let oldIndex = 0;
    let newIndex = 0;
    for (const [oldMatch, newMatch] of [...matches, [before.length, after.length]]) {
      let oldEnd = from;
      let newEnd = insertFrom;
      while (oldIndex < oldMatch) oldEnd += before[oldIndex++].length;
      while (newIndex < newMatch) newEnd += after[newIndex++].length;
      if (oldEnd > from || newEnd > insertFrom) {
        if (lines) split(from, oldEnd, insertFrom, newEnd, false);
        else changes.push({ from, to: oldEnd, insert: next.slice(insertFrom, newEnd) });
      }
      from = oldEnd + (before[oldIndex++]?.length ?? 0);
      insertFrom = newEnd + (after[newIndex++]?.length ?? 0);
    }
  };
  if (previous !== next) split(0, previous.length, 0, next.length, true);
  return changes;
}

/** 有界 Myers 差分：重复行也按顺序匹配，不用全文位置比例猜测未改动区间。 */
function matchingTokens(before: string[], after: string[]): Array<[number, number]> | null {
  const trace: Map<number, number>[] = [];
  let frontier = new Map([[1, 0]]);
  let work = 0;
  for (let distance = 0; distance <= Math.min(before.length + after.length, 512); distance++) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > 250_000) return null;
      const down =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > 250_000) return null;
        x++;
        y++;
      }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        const matches: Array<[number, number]> = [];
        for (let step = distance; step > 0; step--) {
          const prior = trace[step - 1];
          const k = x - y;
          const priorK =
            k === -step || (k !== step && (prior.get(k - 1) ?? -1) < (prior.get(k + 1) ?? -1))
              ? k + 1
              : k - 1;
          const priorX = prior.get(priorK) ?? 0;
          const priorY = priorX - priorK;
          while (x > priorX && y > priorY) matches.push([--x, --y]);
          x = priorX;
          y = priorY;
        }
        while (x > 0 && y > 0) matches.push([--x, --y]);
        return matches.reverse();
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

export interface MarkdownSourceEditorHandle {
  getRuntimeState?(): MarkdownSourceRuntimeState;
  restoreRuntimeState?(state: MarkdownSourceRuntimeState): void;
  getMarkdown(): string;
  setMarkdown(markdown: string, options?: { addToHistory?: boolean }): void;
  getSelection(): MarkdownSourceSelection;
  replaceRange?(from: number, to: number, text: string, expectedRevision?: number): boolean;
  getSelectionStatsSnapshot?(): MarkdownSourceSelectionSnapshot;
  setSelection(from: number, to?: number): void;
  /** 按视口 CSS 坐标定位，不创建视图或写入撤销历史。 */
  placeCaretAtCoordinates(coordinates: { left: number; top: number }): boolean;
  getSelectedMarkdown(): string;
  focus(options?: FocusOptions): void;
  revealRange(from: number, to?: number): void;
  /** 源码模式的搜索高亮；`activeIndex` 为 -1 时只标出全部匹配。 */
  setSearchHighlights?(
    matches: ReadonlyArray<{ from: number; to: number }>,
    activeIndex: number,
  ): void;
  undo(): boolean;
  redo(): boolean;
  lineAtOffset(offset: number): number;
  offsetAtLine(lineNumber: number): number;
  getLineCount(): number;
  /** 与本编辑器 scrollDOM.scrollTop 相同的未缩放坐标，不能直接与屏幕坐标混用。 */
  getLineTop(lineNumber: number): number;
  lineAtHeight(height: number): number;
  getLineHeight(): number;
  getSyncCaretTop?(): number;
  isComposing?(): boolean;
  /** 当前内容的 CodeMirror 测量和视口锚点调整已完成。 */
  isLayoutReady?(): boolean;
  getScrollElement(): HTMLElement;
  getContentElement(): HTMLElement;
  getContentHeight(): number;
  getBlockGeometry(anchors: BlockAlignmentAnchor[]): BlockNaturalGeometry[];
  applyBlockGaps(
    anchors: BlockAlignmentAnchor[],
    gaps: ReadonlyMap<string, number>,
    leadingGap?: number,
  ): void;
  clearBlockGaps(): void;
  requestMeasure(): Promise<void> | void;
}
