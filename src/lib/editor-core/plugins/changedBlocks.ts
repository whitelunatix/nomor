import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

export interface ChangedBlock {
  node: ProseMirrorNode;
  pos: number;
  /** 顶层序号；插件可以据此顺带检查相邻块。 */
  index: number;
}

/**
 * 事务真正改到的顶层块（新文档坐标）。
 *
 * 逐键输入时只有当前段落会返回；插件据此代替整篇 `doc.forEach`/`descendants`
 * 扫描。返回 `null` 表示无法低成本判定（没有 step 或映射异常），调用方应退回
 * 整篇扫描以保证正确性。
 */
export function changedTopLevelBlocks(transaction: Transaction): ChangedBlock[] | null {
  if (transaction.steps.length === 0) return null;
  const ranges: Array<[number, number]> = [];
  try {
    transaction.steps.forEach((step, index) => {
      // step 的 newStart/newEnd 属于该步之后的文档；映射到最终文档再比较。
      const rest = transaction.mapping.slice(index + 1);
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        ranges.push([rest.map(newStart, 1), rest.map(newEnd, -1)]);
      });
    });
  } catch {
    return null;
  }
  if (ranges.length === 0) return null;
  const blocks: ChangedBlock[] = [];
  let index = 0;
  transaction.doc.forEach((node, offset) => {
    const size = node.nodeSize;
    if (ranges.some(([from, to]) => from <= offset + size && to >= offset)) {
      blocks.push({ node, pos: offset, index });
    }
    index += 1;
  });
  return blocks;
}
