import { setBlockType } from 'prosemirror-commands';
import { InputRule } from 'prosemirror-inputrules';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import {
  type Node as PmNode,
  type NodeRange,
  type NodeType,
  type ResolvedPos,
} from 'prosemirror-model';
import { Selection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { canJoin } from 'prosemirror-transform';
import { readTaskListMarker } from './InlineSourceCodec';
import { schema } from './schema';

const listShortcutPattern = /^[ \t]*(?:(\d+)\.|[-+*])(?:[ \t]+\[([ xX])\])?[ \t]*$/;

export function findParentList($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (isList(node)) return { listPos: $pos.before(depth), listType: node.type };
  }
  return null;
}

export function findListItem($pos: ResolvedPos): { itemPos: number; itemNode: PmNode } | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type === schema.nodes.list_item) {
      return { itemPos: $pos.before(depth), itemNode: $pos.node(depth) };
    }
  }
  return null;
}

export function getTaskMarkerRange(item: { itemPos: number; itemNode: PmNode }) {
  const paragraph = item.itemNode.firstChild;
  const marker = paragraph ? readTaskListMarker(paragraph) : null;
  return marker ? { from: item.itemPos + 2, to: item.itemPos + 2 + marker.text.length } : null;
}

export function getListAttrsForType(listType: NodeType) {
  return listType === schema.nodes.ordered_list ? { order: 1 } : null;
}

function isList(node: PmNode): boolean {
  return node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list;
}

function selectedListRange(state: Pick<EditorState, 'selection'>): NodeRange | null {
  const { $from, $to } = state.selection;
  return $from.blockRange($to, (node) => isList(node));
}

function touchesList(state: EditorState): boolean {
  if (findParentList(state.selection.$from) || findParentList(state.selection.$to)) return true;
  let found = false;
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (isList(node)) found = true;
    return !found;
  });
  return found;
}

function selectedItems(range: NodeRange) {
  const items: Array<{ itemPos: number; itemNode: PmNode }> = [];
  let itemPos = range.start;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const itemNode = range.parent.child(index);
    items.push({ itemPos, itemNode });
    itemPos += itemNode.nodeSize;
  }
  return items;
}

function appendCommand(state: EditorState, tr: Transaction, command: Command): boolean {
  let captured: Transaction | undefined;
  if (
    !command(state.apply(tr), (next) => {
      captured = next;
    })
  )
    return false;
  if (captured) {
    for (const step of captured.steps) tr.step(step);
    tr.setSelection(Selection.fromJSON(tr.doc, captured.selection.toJSON()));
  }
  return true;
}

/** 列表内不能降级时消费按键，避免落入正文插入 Tab 或替换选区的兜底。 */
export const indentListItems: Command = (state, dispatch) => {
  if (!touchesList(state)) return false;
  const range = selectedListRange(state);
  if (!range) return true;
  if (range.startIndex > 0) {
    sinkListItem(schema.nodes.list_item)(state, dispatch);
  } else {
    const listPos = range.$from.before(range.depth);
    const previous = state.doc.resolve(listPos).nodeBefore;
    // 类型转换会拆开相邻列表；仍允许把当前项缩进到前一列表的末项，避免操作顺序影响结果。
    if (!previous || !isList(previous) || !canJoin(state.doc, listPos)) return true;
    const tr = state.tr;
    if (range.endIndex < range.parent.childCount) {
      tr.split(range.end, 1);
      if (range.parent.type === schema.nodes.ordered_list) {
        tr.setNodeMarkup(range.end + 1, undefined, {
          ...range.parent.attrs,
          order: range.parent.attrs.order + range.endIndex,
        });
      }
    }
    tr.join(listPos);
    if (appendCommand(state, tr, wrapInList(range.parent.type, range.parent.attrs))) {
      dispatch?.(tr.scrollIntoView());
    }
  }
  return true;
};

function liftSelectedItems(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  clearTasks = false,
) {
  const range = selectedListRange(state);
  if (!range) return false;
  const tr = state.tr;
  // 提升到外层列表仍是任务项；真正退出列表时才清除当前项的标记，保留其子任务。
  if (clearTasks || range.$from.node(range.depth - 1).type !== schema.nodes.list_item) {
    for (const item of selectedItems(range).reverse()) {
      const marker = getTaskMarkerRange(item);
      if (marker) tr.delete(marker.from, marker.to);
    }
  }
  if (!appendCommand(state, tr, liftListItem(schema.nodes.list_item))) return false;
  dispatch?.(tr.scrollIntoView());
  return true;
}

export const outdentListItems: Command = (state, dispatch) => {
  if (!touchesList(state)) return false;
  liftSelectedItems(state, dispatch);
  return true;
};

function joinAdjacentList(tr: Transaction, pos: number) {
  const $pos = tr.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (!before || !after || !isList(before) || before.type !== after.type) return;
  if (
    before.type === schema.nodes.ordered_list &&
    before.attrs.order + before.childCount !== after.attrs.order
  )
    return;
  if (before.attrs.tight !== after.attrs.tight || !canJoin(tr.doc, pos)) return;
  tr.join(pos);
}

/** 只拆分并转换选中项所在的一段列表，不改变未选中的同级项和父列表。 */
export function setListType(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  listType: NodeType,
  attrs: Record<string, unknown> | null = getListAttrsForType(listType),
): boolean {
  const range = selectedListRange(state);
  if (!range) return wrapInList(listType, { ...attrs, tight: true })(state, dispatch);
  if (range.parent.type === listType) return true;
  const tr = state.tr;
  const list = range.parent;
  const listPos = range.$from.before(range.depth);
  if (range.endIndex < list.childCount) {
    tr.split(range.end, 1);
    if (list.type === schema.nodes.ordered_list) {
      tr.setNodeMarkup(range.end + 1, undefined, {
        ...list.attrs,
        order: list.attrs.order + range.endIndex,
      });
    }
  }
  let targetPos = listPos;
  if (range.startIndex > 0) {
    tr.split(range.start, 1);
    targetPos = range.start + 1;
  }
  tr.setNodeMarkup(targetPos, listType, { ...attrs, tight: list.attrs.tight });
  const targetEnd = targetPos + tr.doc.nodeAt(targetPos)!.nodeSize;
  joinAdjacentList(tr, targetEnd);
  joinAdjacentList(tr, targetPos);
  dispatch?.(tr.scrollIntoView());
  return true;
}

export function toggleList(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  listType?: NodeType,
) {
  if (!listType) return false;
  const range = selectedListRange(state);
  return range?.parent.type === listType
    ? liftSelectedItems(state, dispatch, true)
    : setListType(state, dispatch, listType);
}

export const toggleTaskListAtCursor: Command = (state, dispatch) => {
  const range = selectedListRange(state);
  const tr = state.tr;
  if (range) {
    const items = selectedItems(range);
    if (items.some(({ itemNode }) => itemNode.firstChild?.type !== schema.nodes.paragraph))
      return false;
    const remove = items.every((item) => getTaskMarkerRange(item));
    for (const item of items.reverse()) {
      const marker = getTaskMarkerRange(item);
      if (remove && marker) tr.delete(marker.from, marker.to);
      else if (!marker) tr.insertText('[ ] ', item.itemPos + 2);
    }
  } else {
    const textStart = state.selection.$from.start();
    if (
      state.selection.$from.parent.type !== schema.nodes.paragraph &&
      !appendCommand(state, tr, setBlockType(schema.nodes.paragraph))
    )
      return false;
    if (!appendCommand(state, tr, wrapInList(schema.nodes.bullet_list, { tight: true })))
      return false;
    tr.insertText('[ ] ', tr.mapping.map(textStart));
  }
  dispatch?.(tr.scrollIntoView());
  return true;
};

function matchListShortcut($from: ResolvedPos, text: string) {
  if (
    $from.parent.type !== schema.nodes.paragraph ||
    $from.marks().some((mark) => mark.type.spec.code)
  )
    return null;
  const item = findListItem($from);
  const task = item?.itemNode.firstChild === $from.parent ? readTaskListMarker($from.parent) : null;
  const visibleText = task ? text.slice(task.text.length) : text;
  return listShortcutPattern.exec(visibleText);
}

function listShortcutTransaction(state: EditorState, from: number, to: number, text: string) {
  const $from = state.doc.resolve(from);
  if (from !== $from.start()) return null;
  const match = matchListShortcut($from, text);
  if (!match) return null;
  const listType = match[1] ? schema.nodes.ordered_list : schema.nodes.bullet_list;
  const attrs = { ...(match[1] ? { order: Number(match[1]) } : {}), tight: true };
  const tr = state.tr.delete(from, to);
  const range = selectedListRange(tr);
  // 新同级项的符号表示前一项的子列表；已缩进到首项时只转换该项，不再制造空外壳。
  const command: Command = (next, dispatch) =>
    range?.startIndex === 0
      ? setListType(next, dispatch, listType, attrs)
      : wrapInList(listType, attrs)(next, dispatch);
  if (!appendCommand(state, tr, command)) return null;
  if (match[2])
    tr.insertText(`[${match[2].toLowerCase() === 'x' ? 'x' : ' '}] `, tr.selection.$from.start());
  return tr.scrollIntoView();
}

export const convertMarkdownListShortcut: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== $from.parent.content.size) return false;
  const tr = listShortcutTransaction(state, $from.start(), $from.pos, $from.parent.textContent);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
};

/** 单独粘贴符号与逐键输入一样等待分隔符；带分隔符的前缀复用同一层级事务。 */
export function createPastedListShortcut(state: EditorState, text: string) {
  const { $from, $to } = state.selection;
  if (
    !$from.sameParent($to) ||
    $from.parent.type !== schema.nodes.paragraph ||
    /[\r\n]/.test(text) ||
    !listShortcutPattern.test(text)
  ) return null;
  const tr = state.tr.insertText(text);
  const $cursor = tr.selection.$from;
  if (
    $cursor.parentOffset !== $cursor.parent.content.size ||
    !matchListShortcut($cursor, $cursor.parent.textContent)
  ) return null;
  const converted = /[ \t]$/.test(text);
  if (converted && !appendCommand(state, tr, convertMarkdownListShortcut)) return null;
  return { transaction: tr.scrollIntoView(), converted };
}

export function createListInputRule() {
  return new InputRule(
    /^(?:\[[ xX]\][ \t]?)?[ \t]*(?:[-+*]|\d+\.)(?:[ \t]+\[[ xX]\])?[ \t]$/,
    (state, match, start, end) => listShortcutTransaction(state, start, end, match[0].trimEnd()),
  );
}
