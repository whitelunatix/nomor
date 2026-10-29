/** Callout 命令：插入、切换类型、取消 */

import type { Node as PmNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { CalloutType } from './calloutTypes';

/**
 * 插入一个 callout 节点，默认 note 类型，光标进入内部第一个段落。
 * 如果当前已在 callout 内，不重复插入。
 */
export function insertCallout(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  calloutType: CalloutType = 'note',
): boolean {
  const schema = state.schema;
  const { $from } = state.selection;

  // 如果已在 callout 内，不重复插入
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes.callout) {
      return false;
    }
  }

  const calloutNode = schema.nodes.callout;
  if (!calloutNode) return false;

  // 创建一个包含空段落的 callout
  const emptyPara = schema.nodes.paragraph.create();
  const callout = calloutNode.create({ type: calloutType }, emptyPara);

  if (!dispatch) return true;

  const tr =
    state.selection.empty &&
    $from.depth === 1 &&
    $from.parent.isTextblock &&
    $from.parent.content.size === 0
      ? state.tr.replaceWith($from.before(1), $from.after(1), callout)
      : state.tr.replaceSelectionWith(callout);

  setSelectionInsideInsertedCallout(tr);

  dispatch(tr.scrollIntoView());
  return true;
}

function setSelectionInsideInsertedCallout(tr: Transaction): void {
  const calloutType = tr.doc.type.schema.nodes.callout;
  let calloutPos: number | null = null;

  // 段落拆分会在插入节点前补齐边界，只在本次事务新增的范围内找 callout。
  tr.mapping.maps.forEach((stepMap, index) => {
    const remainingMapping = tr.mapping.slice(index + 1);
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (calloutPos !== null || newStart === newEnd) return;
      const from = remainingMapping.map(newStart, -1);
      const to = remainingMapping.map(newEnd, 1);
      if (from >= to) return;

      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (calloutPos !== null) return false;
        if (node.type === calloutType && pos >= from && pos + node.nodeSize <= to) {
          calloutPos = pos;
          return false;
        }
        return true;
      });
    });
  });

  if (calloutPos === null) return;

  const resolvedCalloutPos = calloutPos;
  const callout = tr.doc.nodeAt(resolvedCalloutPos);
  if (!callout || callout.type !== calloutType) return;

  let textPos: number | null = null;
  callout.descendants((node, pos) => {
    if (textPos === null && node.isTextblock) {
      textPos = resolvedCalloutPos + 1 + pos + 1;
      return false;
    }
    return true;
  });

  if (textPos !== null) {
    tr.setSelection(TextSelection.create(tr.doc, textPos));
  }
}

/**
 * 切换已选中 callout 的类型。
 * 如果当前选区不在 callout 内，返回 false。
 */
export function toggleCalloutType(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  newType?: CalloutType,
): boolean {
  const schema = state.schema;
  const { $from } = state.selection;

  // 向上查找 callout 节点
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.callout) {
      if (!dispatch) return true;

      const currentType = node.attrs.type as string;
      // 如果没有指定新类型，按顺序循环
      const types: CalloutType[] = ['note', 'tip', 'important', 'warning', 'caution'];
      const nextType = newType ?? types[(types.indexOf(currentType as CalloutType) + 1) % types.length];

      if (nextType === currentType) return false;

      const pos = $from.before(d);
      const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, type: nextType });
      dispatch(tr.scrollIntoView());
      return true;
    }
  }

  return false;
}

/**
 * 取消 callout：去掉 callout 外壳，原位保留内部块及其属性。
 * 如果当前不在 callout 内，返回 false。
 */
export function unwrapCallout(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const schema = state.schema;
  const { $from } = state.selection;

  // 向上查找 callout 节点
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes.callout) {
      if (!dispatch) return true;

      const calloutPos = $from.before(d);
      const calloutNode = $from.node(d);
      const calloutEnd = $from.after(d);

      // 将 callout 的子节点提取出来，替换整个 callout
      const content = calloutNode.content;
      const tr = state.tr.replaceWith(calloutPos, calloutEnd, content);

      // 光标移到原 callout 位置
      const newPos = Math.min(calloutPos, tr.doc.content.size);
      tr.setSelection(TextSelection.near(tr.doc.resolve(newPos), 1));

      dispatch(tr.scrollIntoView());
      return true;
    }
  }

  return false;
}

/**
 * 在空 callout 内按 Backspace 时，移除 callout 外壳并保留一个普通空段落。
 * 删除最后一个字符产生空 callout 时不触发本命令，必须在已经为空时再次按 Backspace。
 */
export function removeEmptyCalloutOnBackspace(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  if ($from.parent.type !== state.schema.nodes.paragraph || $from.parent.content.size !== 0) {
    return false;
  }

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type !== state.schema.nodes.callout) continue;
    if (!isEmptyCallout(node)) return false;

    if (dispatch) {
      const calloutStart = $from.before(depth);
      const calloutEnd = $from.after(depth);
      const paragraph = state.schema.nodes.paragraph.create();
      const tr = state.tr.replaceWith(calloutStart, calloutEnd, paragraph);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, calloutStart + 1)).scrollIntoView());
    }
    return true;
  }

  return false;
}

/**
 * 检查当前选区是否在 callout 内。
 */
function isInCallout(state: EditorState): boolean {
  const schema = state.schema;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes.callout) {
      return true;
    }
  }
  return false;
}

/**
 * 获取当前选区所在的 callout 节点，不在 callout 内则返回 null。
 */
function getCalloutNode(state: EditorState): PmNode | null {
  const schema = state.schema;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type === schema.nodes.callout) {
      return $from.node(d);
    }
  }
  return null;
}

function isEmptyCallout(node: PmNode): boolean {
  if (node.childCount !== 1) return false;
  const firstChild = node.firstChild;
  return firstChild?.type.name === 'paragraph' && firstChild.content.size === 0;
}
