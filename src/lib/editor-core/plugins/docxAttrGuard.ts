import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

const docxAttrGuardKey = new PluginKey('docxAttrGuard');

type Range = readonly [from: number, to: number];

/**
 * 块类型命令护栏。
 *
 * `setBlockType` / `setNodeMarkup` 只会传入目标节点的新属性，`docxPrefix`
 * 会退回默认值 `null`，导致标题/段落互转时丢失排版指令。这里在事务提交后
 * 把原位置的指令行补回；只修复“原来是块且有前缀、转换后仍缺少前缀”的节点。
 */
export function docxAttrGuardPlugin(): Plugin {
  return new Plugin({
    key: docxAttrGuardKey,
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const pending: Array<{ pos: number; prefix: string[] }> = [];
      // 打字只会改一个块；只检查发生变化的顶层节点，避免每键扫描全篇 600+ 块。
      const changedRanges = changedOldRanges(transactions);

      oldState.doc.forEach((node, offset) => {
        if (
          changedRanges &&
          !changedRanges.some(([from, to]) => from <= offset + node.nodeSize && to >= offset)
        ) {
          return;
        }
        const prefix = readPrefix(node);
        if (!prefix) return;
        let pos = offset;
        for (const transaction of transactions) {
          pos = transaction.mapping.map(pos, 1);
        }
        if (pos < 0 || pos >= newState.doc.content.size) return;
        const current = newState.doc.nodeAt(pos);
        if (!current || !hasPrefixAttr(current.type)) return;
        if (current.attrs.docxPrefix != null) return;
        // 只有“同一个内容块换了类型”才补回指令；真正删除的块不能把前缀
        // 挪给相邻块。setBlockType/setNodeMarkup 会逐字保留原有内容。
        if (current.content.size !== node.content.size || !current.content.eq(node.content)) return;
        pending.push({ pos, prefix });
      });

      if (pending.length === 0) return null;
      const tr = newState.tr;
      let changed = false;
      for (const item of pending) {
        const current = tr.doc.nodeAt(item.pos);
        if (!current || current.attrs.docxPrefix != null) continue;
        tr.setNodeMarkup(item.pos, undefined, { ...current.attrs, docxPrefix: item.prefix });
        changed = true;
      }
      return changed ? tr : null;
    },
  });
}

/**
 * 单步事务（逐字输入、单次替换）的旧坐标变化范围。
 * 多步事务的中间坐标不属于旧文档，返回 null 表示“整篇扫描”以保证正确。
 */
function changedOldRanges(transactions: readonly Transaction[]): Range[] | null {
  if (transactions.length !== 1) return null;
  const transaction = transactions[0]!;
  if (transaction.steps.length !== 1) return null;
  const ranges: Range[] = [];
  transaction.steps[0]!.getMap().forEach((oldStart, oldEnd) => {
    ranges.push([oldStart, oldEnd]);
  });
  return ranges.length > 0 ? ranges : null;
}

function readPrefix(node: ProseMirrorNode): string[] | null {
  const value = node.attrs?.docxPrefix as unknown;
  // 不复制数组：唯一用途是写回新节点的同名属性，原数组本身不会再被修改。
  return Array.isArray(value) && value.length > 0 ? (value as string[]) : null;
}

function hasPrefixAttr(type: ProseMirrorNode['type']): boolean {
  const attrs = type.spec.attrs as Record<string, unknown> | undefined;
  return Boolean(attrs && 'docxPrefix' in attrs);
}
