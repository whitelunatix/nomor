import { TextSelection, type EditorState, type Transaction } from 'prosemirror-state';

/**
 * 把图片节点移动到新的文本位置。
 *
 * - 只接受落在文本块内的落点，避免把行内图片插到块边界；
 * - 删除与插入放在同一个 transaction 里，撤销一次即可回到原位；
 * - 复用原节点，src/alt/title/width/align 等属性保持不变。
 */
export function moveImageTransaction(
  state: EditorState,
  position: number,
  dropPosition: number,
): Transaction | null {
  const node = state.doc.nodeAt(position);
  if (!node || node.type.name !== 'image') return null;
  if (dropPosition >= position && dropPosition <= position + node.nodeSize) return null;

  const $drop = state.doc.resolve(dropPosition);
  if (!$drop.parent.inlineContent) return null;

  const insertPosition = dropPosition > position ? dropPosition - node.nodeSize : dropPosition;
  if (insertPosition === position) return null;

  const tr = state.tr.delete(position, position + node.nodeSize);
  tr.insert(insertPosition, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPosition)));
  return tr;
}
