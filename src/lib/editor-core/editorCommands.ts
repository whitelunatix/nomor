import { setBlockType, splitBlockAs, wrapIn } from 'prosemirror-commands';
import { liftTarget } from 'prosemirror-transform';
import { appendClearInlineSourceStyles, toggleInlineSourceFormat } from './inlineSourceCommands';
import { closeHistory, redo, undo } from 'prosemirror-history';
import { wrapInList } from 'prosemirror-schema-list';
import {
  findParentList,
  findListItem,
  getTaskMarkerRange,
  getListAttrsForType,
  setListType,
  toggleList,
  toggleTaskListAtCursor,
} from './listCommands';
import {
  Fragment,
  type Mark,
  type MarkType,
  type Node as PmNode,
  type NodeType,
} from 'prosemirror-model';
import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { getDiagramTemplate } from './diagramTemplates';
import { CommentBlockNodeView } from './nodeViews/CommentBlockNodeView';
import { CommentInlineNodeView } from './nodeViews/CommentInlineNodeView';
import { MermaidBlockNodeView } from './nodeViews/MermaidBlockNodeView';
import { MathBlockNodeView } from './nodeViews/MathBlockNodeView';
import { startMathInlineDraft } from './plugins/mathInlineDraft';
import { createLinkAttrs } from './link';
import { t } from '../../app/i18n';
import type { QuickInsertEditorCommand } from './quickInsert';

/**
 * 在当前块的下方插入一个新的空段落，并将光标移入。
 * 逻辑：定位当前顶层块的末尾位置，在该位置插入空段落节点。
 */
function insertParagraphAfterCurrentBlock(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!dispatch) return false;
  const { $from } = state.selection;
  const topDepth = 1;
  const afterPos = state.selection instanceof NodeSelection && $from.depth === 0
    ? state.selection.to
    : $from.after(topDepth);
  const emptyParagraph = schema.nodes.paragraph.create();
  const tr = state.tr.insert(afterPos, emptyParagraph);
  // 光标移到新段落的起始位置
  const newPos = afterPos + 1;
  tr.setSelection(TextSelection.create(tr.doc, newPos));
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * 在当前块的上方插入一个新的空段落，并将光标移入。
 * 逻辑：定位当前顶层块的起始位置，在该位置之前插入空段落节点。
 */
function insertParagraphBeforeCurrentBlock(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!dispatch) return false;
  const { $from } = state.selection;
  const topDepth = 1;
  const beforePos = $from.before(topDepth);
  const emptyParagraph = schema.nodes.paragraph.create();
  const tr = state.tr.insert(beforePos, emptyParagraph);
  // 光标移到新段落的起始位置
  tr.setSelection(TextSelection.create(tr.doc, beforePos + 1));
  dispatch(tr.scrollIntoView());
  return true;
}
import {
  addTableColumnAfter,
  addTableColumnBefore,
  addTableRowAfter,
  addTableRowBefore,
  createTableNode,
  deleteCurrentTable,
  deleteCurrentTableColumn,
  deleteCurrentTableRow,
  resizeCurrentTable,
  setTableColumnAlignment,
  toggleFirstTableRowHeader,
} from './tableCommands';
import { insertCallout, toggleCalloutType, unwrapCallout } from './callout/calloutCommands';
import { insertDetails, setDetailsDefaultOpen, unwrapDetails } from './details/detailsCommands';
import { detailsHistoryBoundary, detailsKey } from './details/detailsState';
import type { EditorCommand, SetMarkdownOptions } from './types';
import { createTocList } from '../toc/tocService';
import { ensureFrontMatter } from '../markdown/frontMatter';
import { planOutlineSectionMove, reorderOutlineSection } from '../outline/outlineReorder';
import { extractOutline } from '../outline/outlineService';
import { tryParseMarkdown } from './markdown';

type MarkdownSetter = (markdown: string, options?: SetMarkdownOptions) => void;

const CLEAR_INLINE_MARK_NAMES = [
  'strong',
  'em',
  'underline',
  'highlight',
  'superscript',
  'subscript',
  'strikethrough',
  'link',
  'code',
];
const CLEAR_INLINE_NODE_NAMES = ['math_inline'];

type InlineAtomReplacement = {
  from: number;
  to: number;
  text: string;
};

export type ActiveLinkRange = {
  from: number;
  to: number;
  href: string;
  title: string | null;
  text: string;
  active: boolean;
};

/** 如果当前已是同级标题，则取消为正文；否则设为对应级别 */
function toggleHeading(view: EditorView, level: number): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.heading) {
      if (node.attrs.level === level) {
        return setBlockType(schema.nodes.paragraph)(view.state, view.dispatch);
      }
      break;
    }
  }
  return setBlockType(schema.nodes.heading, { level })(view.state, view.dispatch);
}

/**
 * 提升标题重要性：+ 键
 * 段落 → H1
 * H6 → H5 → ... → H2 → H1（H1 保持不变）
 */
function increaseHeadingLevel(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!dispatch) return false;
  const { $from } = state.selection;
  const currentNode = $from.parent;

  // 段落转为 H1
  if (currentNode.type === schema.nodes.paragraph) {
    return setBlockType(schema.nodes.heading, { level: 1 })(state, dispatch);
  }

  // 标题提升重要性（数字减小）
  if (currentNode.type === schema.nodes.heading) {
    const currentLevel = currentNode.attrs.level as number;
    // H1 已是最高重要性，保持不变
    if (currentLevel <= 1) return false;
    return setBlockType(schema.nodes.heading, { level: currentLevel - 1 })(state, dispatch);
  }

  return false;
}

/**
 * 降低标题重要性：- 键
 * H1 → H2 → H3 → ... → H6（H6 保持不变）
 * 段落不处理
 */
function decreaseHeadingLevel(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (!dispatch) return false;
  const { $from } = state.selection;
  const currentNode = $from.parent;

  // 段落不处理
  if (currentNode.type === schema.nodes.paragraph) {
    return false;
  }

  // 标题降低重要性（数字增大）
  if (currentNode.type === schema.nodes.heading) {
    const currentLevel = currentNode.attrs.level as number;
    // H6 已是最低重要性，保持不变
    if (currentLevel >= 6) return false;
    return setBlockType(schema.nodes.heading, { level: currentLevel + 1 })(state, dispatch);
  }

  return false;
}

/**
 * 自定义 split 命令：标题、脚注定义内回车时，新块退化为普通段落。
 * 行首回车在左侧插入段落，保留右侧原块内容、标题级别及脚注 ID。
 * 其他场景（正文、列表项等）沿用 splitBlock 默认行为。
 */
export function splitBlockExitHeading(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from, empty } = state.selection;
  const isPreservedBlockStart =
    empty && $from.parentOffset === 0 && (
      $from.parent.type === schema.nodes.heading ||
      ($from.parent.type === schema.nodes.footnote_def && $from.parent.content.size > 0)
    );
  const splitCommand = splitBlockAs((node) => {
    // 行首回车让默认拆分逻辑把空白左侧转为正文，并保留右侧原块。
    if (isPreservedBlockStart && (
      node.type === schema.nodes.heading || node.type === schema.nodes.footnote_def
    )) {
      return null;
    }

    // 中间或末尾回车退出原块；脚注 ID 只能留在原定义上，不能复制到新块。
    if (node.type === schema.nodes.heading || node.type === schema.nodes.footnote_def) {
      return { type: schema.nodes.paragraph };
    }
    // 其他场景沿用默认行为
    return null;
  });

  if (!dispatch) return splitCommand(state);

  return splitCommand(state, (tr) => {
    if (!empty && $from.parent.type === schema.nodes.footnote_def && $from.parentOffset === 0) {
      // 行首选区被删除后，默认逻辑会把空白左侧转为正文；恢复原定义，避免丢失脚注 ID。
      tr.setNodeMarkup(tr.mapping.map($from.before(), -1), schema.nodes.footnote_def, $from.parent.attrs);
    }
    if (isPreservedBlockStart) {
      // 行首拆分保留右侧原块，光标移入左侧新段落。
      tr.setSelection(TextSelection.create(tr.doc, $from.pos));
    }
    dispatch(tr);
  });
}

/**
 * Shift+Enter 表达显式段内换行，沿用 Markdown 硬换行的保存规则。
 * 源码普通单换行仍由解析器标为 soft，允许 KP 合并；手动换行不能被合并。
 */
export function insertParagraphLineBreak(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { selection } = state;
  const { $from, $to } = selection;

  // 步骤1：只处理同一个 paragraph 内的选择，标题等块交给 Enter 回退逻辑。
  if ($from.parent !== $to.parent || $from.parent.type !== schema.nodes.paragraph) {
    return false;
  }

  const lineBreak = schema.nodes.hard_break.create();
  if (dispatch) {
    // 步骤2：替换选区后仍留在同一段落和列表项内，不拆分块。
    dispatch(state.tr.replaceSelectionWith(lineBreak).scrollIntoView());
  }
  return true;
}

function appendCommandSteps(
  state: EditorState,
  tr: Transaction,
  command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
): boolean {
  let capturedTr: Transaction | null = null;
  const handled = command(state.apply(tr), (nextTr) => {
    capturedTr = nextTr;
  });
  if (!handled || !capturedTr) return false;
  for (const step of (capturedTr as Transaction).steps) tr.step(step);
  return true;
}

/** 切换引用：只提升引用的直接子块，保留块内列表和其他容器。 */
function toggleBlockquote(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.blockquote) {
      const range = $from.blockRange($to, (node) => node.type === schema.nodes.blockquote);
      if (!range) return false;
      const target = liftTarget(range);
      if (target === null || target !== range.depth - 1) return false;
      if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
      return true;
    }
  }
  return wrapIn(schema.nodes.blockquote)(state, dispatch);
}

/**
 * 清除行内样式：只处理文本 mark 和行内原子节点，不改变标题、列表、引用等块级语义。
 */
function clearInlineStyles(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { selection } = state;

  if (selection instanceof NodeSelection && isClearableInlineAtom(selection.node)) {
    if (dispatch) {
      const replacementText = getInlineAtomPlainText(selection.node);
      const tr = state.tr;
      replaceRangeWithPlainText(tr, selection.from, selection.to, replacementText);
      const cursor = selection.from + replacementText.length;
      dispatch(
        exitInlinePendingState(tr)
          .setSelection(TextSelection.create(tr.doc, cursor))
          .setStoredMarks([])
          .scrollIntoView(),
      );
    }
    return true;
  }

  if (!selection.empty) {
    return clearInlineStylesInRange(state, dispatch, selection.from, selection.to);
  }

  const sourceTransaction = state.tr;
  if (appendClearInlineSourceStyles(state, sourceTransaction)) {
    const markRange = findClearableMarkRangeAtCursor(state);
    if (markRange) {
      sourceTransaction.removeMark(
        sourceTransaction.mapping.map(markRange.from, -1),
        sourceTransaction.mapping.map(markRange.to, 1),
        markRange.mark.type,
      );
    }
    if (dispatch) {
      dispatch(
        exitInlinePendingState(sourceTransaction)
          .setSelection(createMappedSelection(sourceTransaction, selection.from, selection.to))
          .setStoredMarks([])
          .scrollIntoView(),
      );
    }
    return true;
  }

  const markRange = findClearableMarkRangeAtCursor(state);
  if (markRange) {
    if (dispatch) {
      const tr = state.tr.removeMark(markRange.from, markRange.to, markRange.mark.type);
      dispatch(
        exitInlinePendingState(tr)
          .setSelection(TextSelection.create(tr.doc, clampDocPosition(markRange.cursor, tr.doc)))
          .setStoredMarks([])
          .scrollIntoView(),
      );
    }
    return true;
  }

  const atomReplacement = findAdjacentClearableInlineAtom(state);
  if (atomReplacement) {
    if (dispatch) {
      const tr = state.tr;
      replaceRangeWithPlainText(tr, atomReplacement.from, atomReplacement.to, atomReplacement.text);
      dispatch(
        exitInlinePendingState(tr)
          .setSelection(
            TextSelection.create(tr.doc, atomReplacement.from + atomReplacement.text.length),
          )
          .setStoredMarks([])
          .scrollIntoView(),
      );
    }
    return true;
  }

  if (hasClearableStoredMark(state)) {
    if (dispatch) {
      dispatch(exitInlinePendingState(state.tr).setStoredMarks([]));
    }
    return true;
  }

  return false;
}

function clearInlineStylesInRange(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  from: number,
  to: number,
): boolean {
  const clearableMarks = findClearableMarksInRange(state, from, to);
  const atomReplacements = findClearableInlineAtomsInRange(state, from, to);
  const tr = state.tr;
  const hasSourceStyles = appendClearInlineSourceStyles(state, tr);
  if (clearableMarks.length === 0 && atomReplacements.length === 0 && !hasSourceStyles) return false;

  if (dispatch) {
    for (const markType of getClearableMarkTypes(state)) {
      tr.removeMark(tr.mapping.map(from, -1), tr.mapping.map(to, 1), markType);
    }

    for (const replacement of atomReplacements.reverse()) {
      replaceRangeWithPlainText(
        tr,
        tr.mapping.map(replacement.from, 1),
        tr.mapping.map(replacement.to, -1),
        replacement.text,
      );
    }

    dispatch(
      exitInlinePendingState(tr)
        .setSelection(createMappedSelection(tr, from, to))
        .setStoredMarks([])
        .scrollIntoView(),
    );
  }
  return true;
}

function findClearableMarksInRange(state: EditorState, from: number, to: number): Mark[] {
  const markTypes = new Set(getClearableMarkTypes(state));
  const marks: Mark[] = [];
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (markTypes.has(mark.type)) marks.push(mark);
    }
    return true;
  });
  return marks;
}

function findClearableInlineAtomsInRange(
  state: EditorState,
  from: number,
  to: number,
): InlineAtomReplacement[] {
  const replacements: InlineAtomReplacement[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isClearableInlineAtom(node)) return true;
    const nodeTo = pos + node.nodeSize;
    if (pos >= from && nodeTo <= to) {
      replacements.push({ from: pos, to: nodeTo, text: getInlineAtomPlainText(node) });
    }
    return false;
  });
  return replacements;
}

function findClearableMarkRangeAtCursor(
  state: EditorState,
): { from: number; to: number; mark: Mark; cursor: number } | null {
  const pos = state.selection.from;
  const directMarks = state.storedMarks ?? state.selection.$from.marks();
  const directMark = getFirstClearableMark(directMarks);
  if (directMark) {
    const range = findMarkRangeNearPosition(state, pos, directMark);
    if (range) return { ...range, mark: directMark, cursor: pos };
  }

  const rightMark = getFirstClearableMark(state.selection.$from.nodeAfter?.marks ?? []);
  if (rightMark) {
    const range = findMarkRangeNearPosition(state, pos, rightMark);
    if (range) return { ...range, mark: rightMark, cursor: pos };
  }

  const leftMark = getFirstClearableMark(state.selection.$from.nodeBefore?.marks ?? []);
  if (leftMark) {
    const range = findMarkRangeNearPosition(state, Math.max(pos - 1, 0), leftMark);
    if (range) return { ...range, mark: leftMark, cursor: pos };
  }

  return null;
}

function findMarkRangeNearPosition(
  state: EditorState,
  pos: number,
  mark: Mark,
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.doc.nodesBetween(0, state.doc.content.size, (node, nodePos) => {
    if (found || !node.isInline || !mark.isInSet(node.marks)) return true;
    const from = nodePos;
    const to = nodePos + node.nodeSize;
    if (pos >= from && pos <= to) {
      found = expandMarkRange(state.doc, from, to, mark);
      return false;
    }
    return true;
  });
  return found;
}

function expandMarkRange(
  doc: PmNode,
  initialFrom: number,
  initialTo: number,
  mark: Mark,
): { from: number; to: number } {
  let from = initialFrom;
  let to = initialTo;
  const $from = doc.resolve(initialFrom);
  const $to = doc.resolve(initialTo);
  if (!$from.sameParent($to)) return { from, to };

  // 同一行内容器内双向遍历连续兄弟节点，包含图片/公式且不跨其它链接。
  const parent = $from.parent;
  for (let index = $from.index() - 1; index >= 0; index -= 1) {
    const node = parent.child(index);
    if (!node.isInline || !mark.isInSet(node.marks)) break;
    from -= node.nodeSize;
  }
  for (let index = $to.index(); index < parent.childCount; index += 1) {
    const node = parent.child(index);
    if (!node.isInline || !mark.isInSet(node.marks)) break;
    to += node.nodeSize;
  }
  return { from, to };
}

function findAdjacentClearableInlineAtom(state: EditorState): InlineAtomReplacement | null {
  const { $from } = state.selection;
  const nodeAfter = $from.nodeAfter;
  if (nodeAfter && isClearableInlineAtom(nodeAfter)) {
    return {
      from: $from.pos,
      to: $from.pos + nodeAfter.nodeSize,
      text: getInlineAtomPlainText(nodeAfter),
    };
  }

  const nodeBefore = $from.nodeBefore;
  if (nodeBefore && isClearableInlineAtom(nodeBefore)) {
    return {
      from: $from.pos - nodeBefore.nodeSize,
      to: $from.pos,
      text: getInlineAtomPlainText(nodeBefore),
    };
  }

  return null;
}

function getClearableMarkTypes(state: EditorState): MarkType[] {
  return CLEAR_INLINE_MARK_NAMES.map((name) => state.schema.marks[name]).filter(
    (markType): markType is MarkType => Boolean(markType),
  );
}

function getFirstClearableMark(marks: readonly Mark[]): Mark | null {
  return marks.find((mark) => CLEAR_INLINE_MARK_NAMES.includes(mark.type.name)) ?? null;
}

function hasClearableStoredMark(state: EditorState): boolean {
  return Boolean(
    state.storedMarks?.some((mark) => CLEAR_INLINE_MARK_NAMES.includes(mark.type.name)),
  );
}

function exitInlinePendingState(tr: Transaction): Transaction {
  return tr.setMeta('inlineSourceTemplate', { action: 'clear' });
}

function isClearableInlineAtom(node: PmNode): boolean {
  return node.isInline && CLEAR_INLINE_NODE_NAMES.includes(node.type.name);
}

function getInlineAtomPlainText(node: PmNode): string {
  if (node.type.name === 'math_inline') return String(node.attrs.tex ?? '');
  return node.textContent;
}

function replaceRangeWithPlainText(tr: Transaction, from: number, to: number, text: string): void {
  if (text) {
    tr.replaceWith(from, to, schema.text(text));
  } else {
    tr.delete(from, to);
  }
}

function createMappedSelection(tr: Transaction, from: number, to: number): Selection {
  if (from === to) {
    return TextSelection.create(tr.doc, clampDocPosition(tr.mapping.map(from, 1), tr.doc));
  }
  const mappedFrom = clampDocPosition(tr.mapping.map(from, -1), tr.doc);
  const mappedTo = clampDocPosition(tr.mapping.map(to, 1), tr.doc);
  try {
    return TextSelection.create(tr.doc, mappedFrom, mappedTo);
  } catch {
    return TextSelection.near(tr.doc.resolve(mappedFrom));
  }
}

function clampDocPosition(position: number, doc: PmNode): number {
  return Math.max(0, Math.min(position, doc.content.size));
}

/** 删除触发符号和插入内容共用一个事务；类别选择始终插入或转换，不执行取消样式。 */
export function insertQuickInsertContent(
  view: EditorView,
  from: number,
  to: number,
  command: QuickInsertEditorCommand,
): boolean {
  if (command.type === 'insertMathInline') return startMathInlineDraft(view, { from, to });
  const { state, dispatch } = view;
  const tr = state.tr.delete(from, to);
  tr.setSelection(TextSelection.create(tr.doc, from));
  const prepared = state.apply(tr);
  const { $from } = prepared.selection;

  switch (command.type) {
    case 'insertDetails':
      if (!insertDetails(prepared, next => {
        for (const step of next.steps) tr.step(step);
        tr.setSelection(TextSelection.create(tr.doc, next.selection.anchor, next.selection.head));
        tr.setMeta(detailsKey, next.getMeta(detailsKey));
        tr.setMeta(detailsHistoryBoundary, true);
      })) return false;
      break;
    case 'setHeading':
      if (
        $from.parent.type !== schema.nodes.heading ||
        $from.parent.attrs.level !== command.level
      ) {
        if (
          !appendCommandSteps(
            state,
            tr,
            setBlockType(schema.nodes.heading, { level: command.level }),
          )
        )
          return false;
      }
      break;
    case 'toggleBulletList':
    case 'toggleOrderedList':
    case 'toggleTaskList': {
      const listType =
        command.type === 'toggleOrderedList' ? schema.nodes.ordered_list : schema.nodes.bullet_list;
      const currentList = findParentList($from);
      const item = findListItem($from);
      const taskRange = item ? getTaskMarkerRange(item) : null;
      if (currentList) {
        if (taskRange && command.type !== 'toggleTaskList') tr.delete(taskRange.from, taskRange.to);
        if (currentList.listType !== listType) {
          if (!appendCommandSteps(state, tr, (next, dispatch) => setListType(next, dispatch, listType)))
            return false;
        }
      } else {
        if (
          $from.parent.type !== schema.nodes.paragraph &&
          !appendCommandSteps(state, tr, setBlockType(schema.nodes.paragraph))
        )
          return false;
        if (!appendCommandSteps(state, tr, wrapInList(listType, getListAttrsForType(listType))))
          return false;
      }
      if (command.type === 'toggleTaskList' && !taskRange) {
        const item = findListItem(tr.selection.$from);
        if (item?.itemNode.firstChild?.type !== schema.nodes.paragraph) return false;
        tr.insertText('[ ] ', item.itemPos + 2);
      }
      break;
    }
    case 'toggleBlockquote':
    case 'insertCallout': {
      const type =
        command.type === 'insertCallout' ? schema.nodes.callout : schema.nodes.blockquote;
      const attrs =
        command.type === 'insertCallout' ? { type: command.calloutType ?? 'note' } : undefined;
      let ancestorDepth = 0;
      for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
        if ($from.node(depth).type === type) {
          ancestorDepth = depth;
          break;
        }
      }
      if (ancestorDepth) {
        if (attrs) tr.setNodeMarkup($from.before(ancestorDepth), type, attrs);
      } else if (!appendCommandSteps(state, tr, wrapIn(type, attrs))) return false;
      break;
    }
    case 'insertCommentInline': {
      const node = schema.nodes.comment_inline.create({ content: command.content ?? '' });
      tr.replaceSelectionWith(node, false);
      tr.setSelection(NodeSelection.create(tr.doc, from));
      break;
    }
    case 'insertTable':
    case 'insertCodeBlock':
    case 'insertHorizontalRule':
    case 'insertMathBlock':
    case 'insertDiagramBlock':
    case 'insertCommentBlock': {
      let node: PmNode;
      switch (command.type) {
        case 'insertTable':
          node = createTableNode(command.rows ?? 2, command.columns ?? 3);
          break;
        case 'insertCodeBlock':
          node = schema.nodes.code_block.create({ params: command.language ?? '' });
          break;
        case 'insertMathBlock':
          node = schema.nodes.math_block.create({ tex: command.tex ?? '' });
          break;
        case 'insertDiagramBlock':
          node = schema.nodes.mermaid_block.create({
            code: getDiagramTemplate(command.diagramType).code,
          });
          break;
        case 'insertCommentBlock':
          node = schema.nodes.comment_block.create({ content: command.content ?? '' });
          break;
        case 'insertHorizontalRule':
          node = schema.nodes.horizontal_rule.create();
          break;
      }
      const parentDepth = $from.depth - 1;
      const index = $from.index(parentDepth);
      if (
        $from.parent.content.size === 0 &&
        $from.node(parentDepth).canReplaceWith(index, index + 1, node.type)
      ) {
        tr.replaceWith($from.before(), $from.after(), node);
      } else {
        tr.replaceSelectionWith(node);
      }
      let insertedPos = -1;
      tr.doc.descendants((candidate, pos) => {
        if (candidate === node) insertedPos = pos;
        return insertedPos < 0;
      });
      if (insertedPos < 0) return false;
      if (command.type === 'insertTable') setSelectionInFirstTableCell(tr, insertedPos);
      else if (
        command.type === 'insertCodeBlock' ||
        command.type === 'insertMathBlock' ||
        command.type === 'insertCommentBlock'
      )
        tr.setSelection(NodeSelection.create(tr.doc, insertedPos));
      else if (command.type === 'insertDiagramBlock')
        setSelectionAfterMermaidBlock(tr, insertedPos, node);
      else {
        const afterPos = insertedPos + node.nodeSize;
        if (tr.doc.nodeAt(afterPos)?.type !== schema.nodes.paragraph)
          tr.insert(afterPos, schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
      }
    }
  }
  if (command.type === 'insertCommentInline') CommentInlineNodeView.requestInstantEdit(view);
  else if (command.type === 'insertCommentBlock') CommentBlockNodeView.requestInstantEdit(view);
  dispatch(closeHistory(tr).scrollIntoView());
  if (command.type === 'insertMathBlock')
    MathBlockNodeView.scheduleEnterEditAt(view, tr.selection.from, 'start');
  return true;
}

export function executeEditorCommand(
  command: EditorCommand,
  view: EditorView,
  markdown: string,
  setMarkdown: MarkdownSetter,
): boolean {
  const { state, dispatch } = view;
  const run = (fn: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) =>
    fn(state, dispatch);

  switch (command.type) {
    case 'insertText': {
      if (!(state.selection instanceof TextSelection) || !state.selection.$from.parent.inlineContent) return false;
      const text = state.selection.$from.parent.type.name === 'details_summary' ? command.text.replace(/[\r\n\t]+/g, ' ') : command.text;
      dispatch(closeHistory(state.tr).insertText(text).scrollIntoView());
      dispatch(closeHistory(view.state.tr).setMeta('addToHistory', false));
      return true;
    }
    case 'insertMathInline':
      return startMathInlineDraft(view);
    case 'toggleBold':
      return run(toggleInlineSourceFormat('strong'));
    case 'toggleItalic':
      return run(toggleInlineSourceFormat('em'));
    case 'toggleCode':
      return run(toggleInlineSourceFormat('code'));
    case 'toggleStrikethrough':
      return run(toggleInlineSourceFormat('strikethrough'));
    case 'toggleUnderline':
      return run(toggleInlineSourceFormat('underline'));
    case 'toggleSuperscript':
      return run(toggleInlineSourceFormat('superscript'));
    case 'toggleSubscript':
      return run(toggleInlineSourceFormat('subscript'));
    case 'toggleHighlight':
      return run(toggleInlineSourceFormat('highlight'));
    case 'clearInlineStyles':
      return run(clearInlineStyles);
    case 'setHeading':
      return toggleHeading(view, command.level);
    case 'setParagraph':
      return run(setBlockType(schema.nodes.paragraph));
    case 'toggleBlockquote':
      return run(toggleBlockquote);
    case 'insertCallout':
      return insertCallout(state, dispatch, command.calloutType ?? 'note');
    case 'insertDetails':
      return insertDetails(state, dispatch);
    case 'setDetailsDefaultOpen':
      return setDetailsDefaultOpen(command.open, command.pos)(state, dispatch);
    case 'unwrapDetails':
      return unwrapDetails(command.pos)(state, dispatch);
    case 'toggleCalloutType':
      return toggleCalloutType(state, dispatch, command.calloutType);
    case 'unwrapCallout':
      return unwrapCallout(state, dispatch);
    case 'toggleBulletList':
      return toggleList(state, dispatch, schema.nodes.bullet_list);
    case 'toggleOrderedList':
      return toggleList(state, dispatch, schema.nodes.ordered_list);
    case 'insertLink':
      return applyLinkMark(view, command.href, command.title, command.text);
    case 'removeLink':
      return removeLinkMark(state, dispatch);
    case 'insertImage':
      return insertInlineNode(view, schema.nodes.image, {
        src: command.src,
        alt: command.alt ?? null,
        title: command.title ?? null,
        width: command.width ?? null,
        align: command.align ?? null,
      });
    case 'insertFootnote':
      return insertFootnote(view);
    case 'insertCommentInline':
      return insertInlineComment(view, command.content);
    case 'insertCommentBlock':
      return insertBlockComment(view, command.content);
    case 'insertCodeBlock': {
      // 开关逻辑：已在代码块内则取消（恢复为段落），否则插入新代码块
      const { selection } = state;

      // 检查1：NodeSelection 直接选中了代码块
      if (selection instanceof NodeSelection && selection.node.type === schema.nodes.code_block) {
        const cbPos = selection.from;
        const cbNode = selection.node;
        const cbEnd = cbPos + cbNode.nodeSize;
        const text = cbNode.textContent;
        const lines = text.split('\n');
        const paragraphs: PmNode[] = [];
        const paraType = schema.nodes.paragraph;
        for (const line of lines) {
          paragraphs.push(line ? paraType.create({}, schema.text(line)) : paraType.create());
        }
        const tr = state.tr.replaceWith(cbPos, cbEnd, paragraphs);
        if (text) {
          const fragSize = paragraphs.reduce((s, p) => s + p.nodeSize, 0);
          tr.setSelection(TextSelection.create(tr.doc, cbPos, cbPos + fragSize));
        } else {
          tr.setSelection(TextSelection.near(tr.doc.resolve(cbPos), 1));
        }
        dispatch(tr.scrollIntoView());
        return true;
      }

      // 检查2：光标在代码块内部（通过 depth walk）
      const { $from: cbFrom } = state.selection;
      for (let d = cbFrom.depth; d >= 0; d--) {
        if (cbFrom.node(d).type === schema.nodes.code_block) {
          const cbPos = cbFrom.before(d + 1);
          const cbNode = cbFrom.node(d);
          const cbEnd = cbPos + cbNode.nodeSize;
          const text = cbNode.textContent;
          const lines = text.split('\n');
          const paragraphs: PmNode[] = [];
          const paraType = schema.nodes.paragraph;
          for (const line of lines) {
            paragraphs.push(line ? paraType.create({}, schema.text(line)) : paraType.create());
          }
          const tr = state.tr.replaceWith(cbPos, cbEnd, paragraphs);
          if (text) {
            const fragSize = paragraphs.reduce((s, p) => s + p.nodeSize, 0);
            tr.setSelection(TextSelection.create(tr.doc, cbPos, cbPos + fragSize));
          } else {
            tr.setSelection(TextSelection.near(tr.doc.resolve(cbPos), 1));
          }
          dispatch(tr.scrollIntoView());
          return true;
        }
      }
      // 不在代码块内 → 正常插入（有选中文本时放入代码块）
      const selectedText = state.selection.empty
        ? (command.code ?? '')
        : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
      return insertBlock(view, schema.nodes.code_block, selectedText, {
        params: command.language ?? '',
      });
    }
    case 'toggleTaskList':
      return toggleTaskListAtCursor(state, dispatch);
    case 'insertMathBlock': {
      // 开关逻辑：已在公式块内则取消（恢复为段落），否则插入新公式块
      const { selection } = state;

      // 检查1：NodeSelection 直接选中了公式块
      if (selection instanceof NodeSelection && selection.node.type === schema.nodes.math_block) {
        const mbPos = selection.from;
        const mbNode = selection.node;
        const mbEnd = mbPos + mbNode.nodeSize;
        const tex = mbNode.attrs.tex || '';
        const lines = tex.split('\n');
        const paragraphs: PmNode[] = [];
        const paraType = schema.nodes.paragraph;
        for (const line of lines) {
          paragraphs.push(line ? paraType.create({}, schema.text(line)) : paraType.create());
        }
        const tr = state.tr.replaceWith(mbPos, mbEnd, paragraphs);
        if (tex) {
          const fragSize = paragraphs.reduce((s, p) => s + p.nodeSize, 0);
          tr.setSelection(TextSelection.create(tr.doc, mbPos, mbPos + fragSize));
        } else {
          tr.setSelection(TextSelection.near(tr.doc.resolve(mbPos), 1));
        }
        dispatch(tr.scrollIntoView());
        return true;
      }

      // 检查2：光标在公式块内部（通过 depth walk）
      const { $from: mbFrom } = state.selection;
      for (let d = mbFrom.depth; d >= 0; d--) {
        if (mbFrom.node(d).type === schema.nodes.math_block) {
          const mbPos = mbFrom.before(d + 1);
          const mbNode = mbFrom.node(d);
          const mbEnd = mbPos + mbNode.nodeSize;
          const tex = mbNode.attrs.tex || '';
          const lines = tex.split('\n');
          const paragraphs: PmNode[] = [];
          const paraType = schema.nodes.paragraph;
          for (const line of lines) {
            paragraphs.push(line ? paraType.create({}, schema.text(line)) : paraType.create());
          }
          const tr = state.tr.replaceWith(mbPos, mbEnd, paragraphs);
          if (tex) {
            const fragSize = paragraphs.reduce((s, p) => s + p.nodeSize, 0);
            tr.setSelection(TextSelection.create(tr.doc, mbPos, mbPos + fragSize));
          } else {
            tr.setSelection(TextSelection.near(tr.doc.resolve(mbPos), 1));
          }
          dispatch(tr.scrollIntoView());
          return true;
        }
      }

      // 不在公式块内 → 正常插入（有选中文本时作为 tex 内容）
      const { $from, $to, empty } = state.selection;
      const selectedTex = empty
        ? (command.tex ?? 'E = mc^2')
        : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
      const node = schema.nodes.math_block.create({ tex: selectedTex });
      if ($from.depth <= 1) {
        if (empty && $from.parent.isTextblock && $from.parent.content.size > 0) {
          const insertPos = $from.after(1);
          const tr = state.tr.insert(insertPos, node);
          tr.setSelection(NodeSelection.create(tr.doc, insertPos));
          view.dispatch(tr.scrollIntoView());
          MathBlockNodeView.scheduleEnterEditAt(view, insertPos, 'start');
          return true;
        }

        const blockStart = $from.before(1);
        const blockEnd = $to.after(1);
        const tr = state.tr.replaceWith(blockStart, blockEnd, node);
        tr.setSelection(NodeSelection.create(tr.doc, blockStart));
        view.dispatch(tr.scrollIntoView());
        MathBlockNodeView.scheduleEnterEditAt(view, blockStart, 'start');
      } else {
        const endPos = state.doc.content.size;
        const tr = state.tr.insert(endPos, node);
        tr.setSelection(NodeSelection.create(tr.doc, endPos));
        view.dispatch(tr.scrollIntoView());
        MathBlockNodeView.scheduleEnterEditAt(view, endPos, 'start');
      }
      return true;
    }
    case 'insertMermaidBlock':
      return insertMermaidBlock(view, command.code ?? '', { enterEdit: !command.code });
    case 'insertDiagramBlock':
      return insertMermaidBlock(view, getDiagramTemplate(command.diagramType).code);
    case 'insertToc':
      return insertTocBlock(view, markdown);
    case 'insertFrontMatter':
      return insertFrontMatterBlock(markdown, setMarkdown);
    case 'insertTable': {
      const tableNode = createTableNode(command.rows ?? 3, command.columns ?? 3);
      return insertTable(view, tableNode);
    }
    case 'resizeTable':
      return run(resizeCurrentTable(command.rows, command.columns));
    case 'addTableRowBefore':
      return run(addTableRowBefore());
    case 'addTableRowAfter':
      return run(addTableRowAfter());
    case 'addTableColumnBefore':
      return run(addTableColumnBefore());
    case 'addTableColumnAfter':
      return run(addTableColumnAfter());
    case 'deleteTableRow':
      return run(deleteCurrentTableRow());
    case 'deleteTableColumn':
      return run(deleteCurrentTableColumn());
    case 'deleteTable':
      return run(deleteCurrentTable());
    case 'toggleTableHeader':
      return run(toggleFirstTableRowHeader());
    case 'setTableColumnAlignment':
      return run(setTableColumnAlignment(command.align));
    case 'insertParagraphAfter':
      return insertParagraphAfterCurrentBlock(state, dispatch);
    case 'insertParagraphBefore':
      return insertParagraphBeforeCurrentBlock(state, dispatch);
    case 'increaseHeadingLevel':
      return increaseHeadingLevel(state, dispatch);
    case 'decreaseHeadingLevel':
      return decreaseHeadingLevel(state, dispatch);
    case 'insertHorizontalRule':
      return insertHorizontalRule(view);
    case 'undo':
      return run(undo);
    case 'redo':
      return run(redo);
    case 'moveOutlineSection':
      return moveOutlineSection(view, command, markdown);
    case 'scrollToHeading':
      return scrollToHeading(view, command.headingIndex);
    default:
      return false;
  }
}

/**
 * 按大纲索引移动章节子树。大纲索引覆盖全部标题；顶层节点重排只适用于所有标题都在顶层的文档，
 * 列表、引用等容器内的标题会让顶层标题表与大纲索引错位，此时改用 Markdown 层重排结果。
 */
function moveOutlineSection(
  view: EditorView,
  command: Extract<EditorCommand, { type: 'moveOutlineSection' }>,
  markdown: string,
): boolean {
  const { state } = view;
  const topLevelNodes: Array<{ node: PmNode; pos: number }> = [];
  const headings: Array<{ childIndex: number; level: number }> = [];
  let hasNestedHeading = false;
  let pos = 0;
  for (let childIndex = 0; childIndex < state.doc.childCount; childIndex += 1) {
    const node = state.doc.child(childIndex);
    topLevelNodes.push({ node, pos });
    if (node.type === state.schema.nodes.heading) {
      headings.push({ childIndex, level: Number(node.attrs.level) });
    } else if (!hasNestedHeading) {
      node.descendants((child) => {
        if (child.type === state.schema.nodes.heading) hasNestedHeading = true;
        return !hasNestedHeading;
      });
    }
    pos += node.nodeSize;
  }
  if (hasNestedHeading) return moveOutlineSectionByMarkdown(view, command, markdown);

  const planResult = planOutlineSectionMove(headings, command);
  if (!planResult.ok) return false;
  const { plan } = planResult;
  const sourceStartChild = headings[plan.sourceStartIndex].childIndex;
  const sourceEndChild = headings[plan.sourceEndIndex]?.childIndex ?? state.doc.childCount;
  const insertionHeadingIndex =
    command.placement === 'before' ? command.targetIndex : plan.targetEndIndex;
  const insertionChild = headings[insertionHeadingIndex]?.childIndex ?? state.doc.childCount;
  const from = topLevelNodes[sourceStartChild].pos;
  const to = topLevelNodes[sourceEndChild]?.pos ?? state.doc.content.size;
  const insertionPos = topLevelNodes[insertionChild]?.pos ?? state.doc.content.size;
  const movedHeadingLevels = new Map(
    headings
      .slice(plan.sourceStartIndex, plan.sourceEndIndex)
      .map((heading) => [heading.childIndex, heading.level + plan.levelDelta]),
  );
  const movedNodes = topLevelNodes
    .slice(sourceStartChild, sourceEndChild)
    .map(({ node }, offset) => {
      const nextLevel = movedHeadingLevels.get(sourceStartChild + offset);
      if (!nextLevel) return node;
      return node.type.create(
        { ...node.attrs, level: nextLevel },
        node.content,
        node.marks,
      );
    });
  const mappedInsertionPos = insertionPos > from ? insertionPos - (to - from) : insertionPos;
  const tr = state.tr.delete(from, to).insert(mappedInsertionPos, Fragment.fromArray(movedNodes));
  tr.setSelection(TextSelection.near(tr.doc.resolve(mappedInsertionPos + 1)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** 用与源码模式相同的行级重排结果替换整篇文档，保持为单个可撤销事务。 */
function moveOutlineSectionByMarkdown(
  view: EditorView,
  command: Extract<EditorCommand, { type: 'moveOutlineSection' }>,
  markdown: string,
): boolean {
  const result = reorderOutlineSection(markdown, extractOutline(markdown), command);
  if (!result.ok) return false;
  const nextDoc = tryParseMarkdown(result.markdown);
  if (!nextDoc) return false;
  const { state } = view;
  const tr = state.tr.replaceWith(0, state.doc.content.size, nextDoc.content);
  let headingIndex = 0;
  let movedHeadingPos = -1;
  tr.doc.descendants((node, nodePos) => {
    if (movedHeadingPos >= 0) return false;
    if (node.type !== state.schema.nodes.heading) return true;
    if (headingIndex === result.movedHeadingIndex) movedHeadingPos = nodePos;
    headingIndex += 1;
    return false;
  });
  tr.setSelection(
    movedHeadingPos >= 0
      ? TextSelection.near(tr.doc.resolve(movedHeadingPos + 1))
      : TextSelection.atStart(tr.doc),
  );
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertFrontMatterBlock(markdown: string, setMarkdown: MarkdownSetter): boolean {
  const nextMarkdown = ensureFrontMatter(markdown);
  if (nextMarkdown !== markdown) {
    setMarkdown(nextMarkdown, { reason: 'programmatic-update' });
  }
  return true;
}

function insertTocBlock(view: EditorView, markdown: string): boolean {
  const node = schema.nodes.toc_block.create({ content: createTocList(markdown) });
  const { state } = view;
  const { $from, empty } = state.selection;

  if (empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    const blockStart = $from.before(1);
    const blockEnd = $from.after(1);
    const tr = state.tr.replaceWith(blockStart, blockEnd, node);
    tr.setSelection(NodeSelection.create(tr.doc, blockStart));
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const tr = state.tr.replaceSelectionWith(node);
  const nodePos = tr.mapping.map(state.selection.from, -1);
  if (tr.doc.nodeAt(nodePos)?.type === schema.nodes.toc_block) {
    tr.setSelection(NodeSelection.create(tr.doc, nodePos));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function scrollToHeading(view: EditorView, headingIndex: number): boolean {
  let foundPos: number | null = null;
  let headingCount = 0;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      headingCount += 1;
      if (headingCount === headingIndex + 1) {
        foundPos = pos;
        return false;
      }
    }
  });

  if (foundPos === null) return false;

  const $pos = view.state.doc.resolve(foundPos);
  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)).scrollIntoView());
  return true;
}

function insertInlineNode(
  view: EditorView,
  type: NodeType,
  attrs: Record<string, unknown>,
): boolean {
  const node = type.createAndFill(attrs);
  if (!node) return false;

  view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  return true;
}

export function findActiveLinkRange(state: EditorState): ActiveLinkRange | null {
  const markType = state.schema.marks.link;
  if (!markType) return null;

  const { selection } = state;
  if (!selection.empty) {
    const selectedText = state.doc.textBetween(selection.from, selection.to, '\n');
    const firstLink = findFirstLinkMarkInRange(state, selection.from, selection.to);
    if (firstLink) {
      return {
        ...firstLink,
        from: selection.from,
        to: selection.to,
        text: selectedText,
        active: true,
      };
    }
    return {
      from: selection.from,
      to: selection.to,
      href: '',
      title: null,
      text: selectedText,
      active: false,
    };
  }

  const cursor = selection.from;
  const marks = [
    ...(state.storedMarks ?? selection.$from.marks()),
    ...(selection.$from.nodeAfter?.marks ?? []),
    ...(selection.$from.nodeBefore?.marks ?? []),
  ];
  const linkMark = marks.find((mark) => mark.type === markType);
  if (!linkMark) {
    return {
      from: cursor,
      to: cursor,
      href: '',
      title: null,
      text: '',
      active: false,
    };
  }

  const range = findMarkRangeNearPosition(state, cursor, linkMark);
  if (!range) {
    return {
      from: cursor,
      to: cursor,
      href: String(linkMark.attrs.href ?? ''),
      title: linkMark.attrs.title ? String(linkMark.attrs.title) : null,
      text: '',
      active: false,
    };
  }

  return {
    ...range,
    href: String(linkMark.attrs.href ?? ''),
    title: linkMark.attrs.title ? String(linkMark.attrs.title) : null,
    text: state.doc.textBetween(range.from, range.to, '\n'),
    active: true,
  };
}

function findFirstLinkMarkInRange(
  state: EditorState,
  from: number,
  to: number,
): Pick<ActiveLinkRange, 'href' | 'title'> | null {
  let found: Pick<ActiveLinkRange, 'href' | 'title'> | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (found || !node.isInline) return true;
    const link = node.marks.find((mark) => mark.type === state.schema.marks.link);
    if (link) {
      found = {
        href: String(link.attrs.href ?? ''),
        title: link.attrs.title ? String(link.attrs.title) : null,
      };
      return false;
    }
    return true;
  });
  return found;
}

function applyLinkMark(view: EditorView, href: string, title?: string, text?: string): boolean {
  const attrs = createLinkAttrs(href, title);
  if (!attrs) return false;

  const { state } = view;
  const markType = state.schema.marks.link;
  const activeLink = findActiveLinkRange(state);
  const targetText = text?.trim() ? text : undefined;

  if (activeLink && (activeLink.active || !state.selection.empty)) {
    if (activeLink.from >= activeLink.to) return false;
    const replacementText = targetText || activeLink.text;
    const textChanged = replacementText !== activeLink.text;
    // 修改文字只允许发生在同一行内容器，避免替换跨段选区时吞掉块结构。
    if (textChanged && !state.doc.resolve(activeLink.from).sameParent(state.doc.resolve(activeLink.to))) {
      return false;
    }

    const tr = state.tr;
    let originalLink: Mark | undefined;
    let hasInlineTarget = false;
    state.doc.nodesBetween(activeLink.from, activeLink.to, (node, pos, parent) => {
      if (!node.isInline) return true;
      if (!parent?.type.allowsMarkType(markType)) return false;
      hasInlineTarget = true;
      const existingLink = node.marks.find((mark) => mark.type === markType);
      originalLink ??= existingLink;
      // 每个原链接独立保留锚点属性，不把首个 id/name 复制到其它链接。
      if (!textChanged) {
        const linkMark = markType.create({ ...existingLink?.attrs, ...attrs });
        tr.addMark(Math.max(activeLink.from, pos), Math.min(activeLink.to, pos + node.nodeSize), linkMark);
      }
      return false;
    });
    if (!hasInlineTarget) return false;

    if (textChanged) {
      const linkMark = markType.create({ ...originalLink?.attrs, ...attrs });
      tr.replaceWith(activeLink.from, activeLink.to, schema.text(replacementText, [linkMark]));
      tr.setSelection(
        TextSelection.create(tr.doc, activeLink.from, activeLink.from + replacementText.length),
      );
    } else {
      tr.setSelection(TextSelection.create(tr.doc, activeLink.from, activeLink.to));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const linkMark = markType.create(attrs);
  const replacementText = targetText || attrs.href;
  const tr = state.tr.replaceSelectionWith(schema.text(replacementText, [linkMark]), false);
  const from = tr.selection.from - replacementText.length;
  tr.setSelection(TextSelection.create(tr.doc, from, from + replacementText.length));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function removeLinkMark(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const activeLink = findActiveLinkRange(state);
  if (!activeLink?.active || activeLink.from >= activeLink.to) return false;
  if (dispatch) {
    const tr = state.tr.removeMark(activeLink.from, activeLink.to, state.schema.marks.link);
    dispatch(
      tr
        .setSelection(TextSelection.create(tr.doc, activeLink.from, activeLink.to))
        .scrollIntoView(),
    );
  }
  return true;
}

function insertTable(view: EditorView, tableNode: PmNode): boolean {
  const { state } = view;
  const { $from, empty } = state.selection;

  // 步骤1：空段落中插入表格时，替换整个段落，确保表格起点不会贴到下方旧表格。
  if (empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    const tablePos = $from.before(1);
    const blockEnd = $from.after(1);
    const tr = state.tr.replaceWith(tablePos, blockEnd, tableNode);
    setSelectionInFirstTableCell(tr, tablePos);
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const tr = state.tr.replaceSelectionWith(tableNode);
  const tablePos = tr.mapping.map(state.selection.from, -1);
  if (tr.doc.nodeAt(tablePos)?.type === schema.nodes.table) {
    setSelectionInFirstTableCell(tr, tablePos);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertFootnote(view: EditorView): boolean {
  const { state } = view;
  const id = createNextFootnoteId(state.doc);
  const footnoteRef = schema.nodes.footnote_ref.create({ id });
  const footnoteDef = schema.nodes.footnote_def.create({ id });

  let tr = state.tr.replaceSelectionWith(footnoteRef, false);
  const defPos = tr.doc.content.size;
  tr = tr.insert(defPos, footnoteDef);
  tr = tr.setSelection(TextSelection.create(tr.doc, defPos + 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertInlineComment(view: EditorView, content?: string): boolean {
  const { state } = view;
  const selectedText = state.selection.empty
    ? ''
    : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  const node = schema.nodes.comment_inline.create({
    content: content ?? (selectedText || t.inlineComment()),
  });
  const tr = state.tr.replaceSelectionWith(node, false);
  const nodePos = tr.mapping.map(state.selection.from, -1);
  if (tr.doc.nodeAt(nodePos)?.type === schema.nodes.comment_inline) {
    tr.setSelection(NodeSelection.create(tr.doc, nodePos));
    CommentInlineNodeView.requestInstantEdit(view);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertBlockComment(view: EditorView, content?: string): boolean {
  const { state } = view;
  const { $from, $to, empty } = state.selection;
  const selectedText = empty
    ? ''
    : state.doc.textBetween(state.selection.from, state.selection.to, '\n');
  const node = schema.nodes.comment_block.create({
    content: content ?? (selectedText || t.blockComment()),
  });

  let tr: Transaction;
  let nodePos: number;
  if (empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    nodePos = $from.before(1);
    tr = state.tr.replaceWith(nodePos, $from.after(1), node);
  } else if (empty && $from.depth === 1 && $from.parent.isTextblock) {
    nodePos = $from.after(1);
    tr = state.tr.insert(nodePos, node);
  } else if ($from.depth === 1 && $to.depth === 1) {
    nodePos = $from.before(1);
    tr = state.tr.replaceWith(nodePos, $to.after(1), node);
  } else {
    nodePos = state.doc.content.size;
    tr = state.tr.insert(nodePos, node);
  }

  tr.setSelection(NodeSelection.create(tr.doc, nodePos));
  CommentBlockNodeView.requestInstantEdit(view);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function createNextFootnoteId(doc: PmNode): string {
  // 数字编号按十进制字符串比较和递增，避免超过安全整数时复用已有 ID。
  let maxNumericId = '0';
  doc.descendants((node) => {
    if (node.type.name !== 'footnote_ref' && node.type.name !== 'footnote_def') {
      return true;
    }

    const id = String(node.attrs.id ?? '');
    if (/^\d+$/.test(id)) {
      const numericId = id.replace(/^0+/, '') || '0';
      if (
        numericId.length > maxNumericId.length ||
        (numericId.length === maxNumericId.length && numericId > maxNumericId)
      ) {
        maxNumericId = numericId;
      }
    }
    return true;
  });

  const digits = maxNumericId.split('');
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== '9') {
      digits[index] = String(Number(digits[index]) + 1);
      return digits.join('');
    }
    digits[index] = '0';
  }
  return `1${digits.join('')}`;
}

function setSelectionInFirstTableCell(tr: Transaction, tablePos: number): void {
  const table = tr.doc.nodeAt(tablePos);
  if (!table || table.type !== schema.nodes.table) return;

  let textPos: number | null = null;
  table.descendants((node, pos) => {
    if (textPos === null && node.isTextblock) {
      textPos = tablePos + 1 + pos + 1;
      return false;
    }
    return true;
  });

  if (textPos !== null) {
    tr.setSelection(TextSelection.create(tr.doc, textPos));
  }
}

function insertBlock(
  view: EditorView,
  type: NodeType,
  text: string,
  attrs?: Record<string, unknown>,
): boolean {
  const content = text ? schema.text(text) : undefined;
  const node = type.create(attrs, content);
  const { state } = view;
  const { $from, empty } = state.selection;

  // 步骤1：空段落插入块时，直接替换整个段落。
  // 这样能拿到新节点的精确起点，避免相邻代码块之间用近似位置误进入旧块。
  if (empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    const blockStart = $from.before(1);
    const blockEnd = $from.after(1);
    const tr = state.tr.replaceWith(blockStart, blockEnd, node);
    if (type.name === 'code_block' || type.name === 'mermaid_block') {
      tr.setSelection(NodeSelection.create(tr.doc, blockStart));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  // 步骤2：正文段落中空选区插入块时，保留当前正文，把新块插到当前顶层块下方。
  // 这样工具栏插入代码块不会误删用户正在写的段落内容。
  if (empty && $from.depth === 1 && $from.parent.isTextblock) {
    const insertPos = $from.after(1);
    const tr = state.tr.insert(insertPos, node);
    if (type.name === 'code_block' || type.name === 'mermaid_block') {
      tr.setSelection(NodeSelection.create(tr.doc, insertPos));
    }
    view.dispatch(tr.scrollIntoView());
    return true;
  }

  const tr = state.tr.replaceSelectionWith(node);
  const newPos = tr.mapping.map(state.selection.from, -1);
  if (
    (type.name === 'code_block' || type.name === 'mermaid_block') &&
    tr.doc.nodeAt(newPos)?.type === type
  ) {
    tr.setSelection(NodeSelection.create(tr.doc, newPos));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function insertMermaidBlock(
  view: EditorView,
  code: string,
  options: { enterEdit?: boolean } = {},
): boolean {
  const node = schema.nodes.mermaid_block.create({ code });
  const { state } = view;
  const { selection } = state;
  const { $from, empty } = selection;

  // 步骤0：当前选中的是一个块级节点时，把图表插到该块后方，避免误删公式块、表格等内容。
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    const insertPos = selection.to;
    const tr = state.tr.insert(insertPos, node);
    setSelectionAfterMermaidBlock(tr, insertPos, node);
    view.dispatch(tr.scrollIntoView());
    enterMermaidEditWhenReady(view, insertPos, options);
    return true;
  }

  // 步骤1：空段落里插入图表时，直接替换当前段落，并补一个后续输入段落。
  // Mermaid 常态只负责渲染，不能停留在 NodeSelection 选中态。
  if (empty && $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0) {
    const blockStart = $from.before(1);
    const blockEnd = $from.after(1);
    const tr = state.tr.replaceWith(blockStart, blockEnd, node);
    setSelectionAfterMermaidBlock(tr, blockStart, node);
    view.dispatch(tr.scrollIntoView());
    enterMermaidEditWhenReady(view, blockStart, options);
    return true;
  }

  // 步骤2：正文段落中插入图表时，保留原文，把图表放到当前块下方。
  if (empty && $from.depth === 1 && $from.parent.isTextblock) {
    const insertPos = $from.after(1);
    const tr = state.tr.insert(insertPos, node);
    setSelectionAfterMermaidBlock(tr, insertPos, node);
    view.dispatch(tr.scrollIntoView());
    enterMermaidEditWhenReady(view, insertPos, options);
    return true;
  }

  // 步骤3：有选区时用图表替换选中内容，随后仍把光标放到图表后方。
  const tr = state.tr.replaceSelectionWith(node);
  const insertedPos = tr.mapping.map(state.selection.from, -1);
  if (tr.doc.nodeAt(insertedPos)?.type === schema.nodes.mermaid_block) {
    setSelectionAfterMermaidBlock(tr, insertedPos, node);
  }
  view.dispatch(tr.scrollIntoView());
  enterMermaidEditWhenReady(view, insertedPos, options);
  return true;
}

function enterMermaidEditWhenReady(
  view: EditorView,
  pos: number,
  options: { enterEdit?: boolean },
): void {
  if (!options.enterEdit) return;
  if (MermaidBlockNodeView.enterEditAt(view, pos, 'start')) return;
  if (MermaidBlockNodeView.enterClosestEditAt(view, pos, 'start')) return;
  requestAnimationFrame(() => {
    if (MermaidBlockNodeView.enterEditAt(view, pos, 'start')) return;
    MermaidBlockNodeView.enterClosestEditAt(view, pos, 'start');
  });
}

function setSelectionAfterMermaidBlock(
  tr: Transaction,
  blockPos: number,
  mermaidNode: PmNode,
): void {
  const afterPos = blockPos + mermaidNode.nodeSize;
  const nextNode = tr.doc.nodeAt(afterPos);

  if (nextNode?.type === schema.nodes.paragraph) {
    tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
    return;
  }

  tr.insert(afterPos, schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
}

/**
 * 插入/取消水平分割线。
 *
 * 行为：
 * - 直接选中了水平分割线：删除它。
 * - 光标在空段落且紧邻水平分割线：删除相邻的水平分割线（开关逻辑）。
 * - 否则：在当前块位置插入 HR，并在下方新建空段落聚焦。
 */
function insertHorizontalRule(view: EditorView): boolean {
  const { state, dispatch } = view;
  const { selection } = state;

  // 1. 直接选中水平分割线：删除
  if (selection instanceof NodeSelection && selection.node.type === schema.nodes.horizontal_rule) {
    const tr = state.tr.delete(selection.from, selection.to);
    const $pos = tr.doc.resolve(clampDocPosition(selection.from, tr.doc));
    tr.setSelection(TextSelection.near($pos, 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  const { $from, empty } = selection;
  const hrNode = schema.nodes.horizontal_rule.create();
  const emptyParagraph = schema.nodes.paragraph.create();

  // 2. 光标在空段落且紧邻水平分割线：取消相邻的分割线
  if (
    empty &&
    $from.depth === 1 &&
    $from.parent.type === schema.nodes.paragraph &&
    $from.parent.content.size === 0
  ) {
    const currentIndex = $from.index(0);
    const docNode = $from.doc;

    // 优先取消前一条水平分割线
    if (currentIndex > 0) {
      const prevNode = docNode.child(currentIndex - 1);
      if (prevNode.type === schema.nodes.horizontal_rule) {
        const hrFrom = $from.before(1) - prevNode.nodeSize;
        const tr = state.tr.delete(hrFrom, $from.before(1));
        tr.setSelection(TextSelection.create(tr.doc, hrFrom + 1));
        dispatch(tr.scrollIntoView());
        return true;
      }
    }

    // 其次取消后一条水平分割线
    if (currentIndex < docNode.childCount - 1) {
      const nextNode = docNode.child(currentIndex + 1);
      if (nextNode.type === schema.nodes.horizontal_rule) {
        const hrFrom = $from.after(1);
        const tr = state.tr.delete(hrFrom, hrFrom + nextNode.nodeSize);
        tr.setSelection(TextSelection.create(tr.doc, $from.start(1)));
        dispatch(tr.scrollIntoView());
        return true;
      }
    }

    // 当前是空段落，但附近没有分割线：替换为 HR + 空段落
    const blockStart = $from.before(1);
    const blockEnd = $from.after(1);
    const tr = state.tr.replaceWith(blockStart, blockEnd, [hrNode, emptyParagraph]);
    tr.setSelection(TextSelection.create(tr.doc, blockStart + hrNode.nodeSize + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  // 3. 默认：在当前位置后插入 HR + 空段落
  const insertPos = $from.after(1);
  const tr = state.tr.insert(insertPos, [hrNode, emptyParagraph]);
  tr.setSelection(TextSelection.create(tr.doc, insertPos + hrNode.nodeSize + 1));
  dispatch(tr.scrollIntoView());
  return true;
}
