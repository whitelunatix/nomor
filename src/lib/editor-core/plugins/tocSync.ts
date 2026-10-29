import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { createDocumentTocList, extractDocumentTocItems } from '../../toc/tocService';
import { schema } from '../schema';

const tocSyncKey = new PluginKey<DecorationSet>('tocSync');

/**
 * 正文目录同步插件：标题变化后原位更新 TOC 节点，不重建 EditorState。
 *
 * TOC 是标题派生内容，不应形成独立撤销步骤；标题事务撤销或重做时，
 * 插件会基于新文档状态重新生成目录。
 */
export function tocSyncPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tocSyncKey,
    state: {
      init: (_config, state) => buildHeadingDecorations(state.doc),
      apply(transaction, value) {
        if (!transaction.docChanged) return value;
        // 普通段落里打字只需平移标题锚点；只有改动标题本身（标题文本决定 id）
        // 或增删标题时才重建，避免每键遍历整篇文档。
        return transactionsTouchHeadingsOrToc([transaction])
          ? buildHeadingDecorations(transaction.doc)
          : value.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return tocSyncKey.getState(state) ?? null;
      },
    },
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      if (transactions.every((transaction) => transaction.getMeta(tocSyncKey))) return null;
      if (!transactionsTouchHeadingsOrToc(transactions)) return null;

      const tocNodes = collectTocNodes(newState.doc);
      if (tocNodes.length === 0) return null;

      const content = createDocumentTocList(newState.doc);
      const staleTocNodes = tocNodes.filter(({ node }) => node.attrs.content !== content);
      if (staleTocNodes.length === 0) return null;

      const transaction = newState.tr;
      for (const { pos } of staleTocNodes) {
        transaction.setNodeAttribute(pos, 'content', content);
      }

      transaction.setMeta('addToHistory', false);
      transaction.setMeta(tocSyncKey, true);
      return transaction;
    },
  });
}

function buildHeadingDecorations(doc: ProseMirrorNode): DecorationSet {
  // 标题 id 由标题文本推导：文档改标题或增删标题时必须整篇重算。
  return DecorationSet.create(
    doc,
    extractDocumentTocItems(doc).map((item) => {
      const node = doc.nodeAt(item.pos)!;
      return Decoration.node(item.pos, item.pos + node.nodeSize, { id: item.id });
    }),
  );
}

function collectTocNodes(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; pos: number }> {
  const tocNodes: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.toc_block) {
      tocNodes.push({ node, pos });
      return false;
    }
    return true;
  });
  return tocNodes;
}

function transactionsTouchHeadingsOrToc(transactions: readonly Transaction[]): boolean {
  return transactions.some((transaction) =>
    transaction.steps.some((step, stepIndex) => {
      const before = transaction.docs[stepIndex];
      const after = transaction.docs[stepIndex + 1] ?? transaction.doc;
      let touchesRelevantNode = false;
      let hasMappedRange = false;

      step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
        hasMappedRange = true;
        if (touchesRelevantNode) return;
        touchesRelevantNode =
          rangeTouchesHeadingsOrToc(before, oldStart, oldEnd) ||
          rangeTouchesHeadingsOrToc(after, newStart, newEnd);
      });

      if (!hasMappedRange) {
        const stepJson = step.toJSON() as { pos?: unknown };
        if (typeof stepJson.pos === 'number') {
          touchesRelevantNode = rangeTouchesHeadingsOrToc(after, stepJson.pos, stepJson.pos);
        }
      }

      return touchesRelevantNode;
    }),
  );
}

function rangeTouchesHeadingsOrToc(doc: ProseMirrorNode, from: number, to: number): boolean {
  const maxPosition = doc.content.size;
  const start = Math.max(0, Math.min(from, maxPosition));
  const end = Math.max(start, Math.min(to, maxPosition));

  if (resolvedPositionTouchesHeadingsOrToc(doc, start)) return true;
  if (end !== start && resolvedPositionTouchesHeadingsOrToc(doc, end)) return true;

  let touchesRelevantNode = false;
  const scanFrom = Math.max(0, start - 1);
  const scanTo = Math.min(maxPosition, end + 1);
  doc.nodesBetween(scanFrom, scanTo, (node) => {
    if (node.type === schema.nodes.heading || node.type === schema.nodes.toc_block) {
      touchesRelevantNode = true;
      return false;
    }
    return !touchesRelevantNode;
  });
  return touchesRelevantNode;
}

function resolvedPositionTouchesHeadingsOrToc(doc: ProseMirrorNode, position: number): boolean {
  const resolved = doc.resolve(position);
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    const node = resolved.node(depth);
    if (node.type === schema.nodes.heading || node.type === schema.nodes.toc_block) {
      return true;
    }
  }
  return false;
}
