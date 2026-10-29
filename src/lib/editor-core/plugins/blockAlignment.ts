import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

export interface SemanticBlockAlignmentGap {
  key: string;
  nodeIndex: number;
  height: number;
  marginCompensation?: number;
}

const blockAlignmentPluginKey = new PluginKey<DecorationSet>('blockAlignment');
const blockAlignmentMeta = 'nomo:block-alignment';

export function blockAlignmentPlugin() {
  return new Plugin<DecorationSet>({
    key: blockAlignmentPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, decorations) {
        const gaps = transaction.getMeta(blockAlignmentMeta) as
          | readonly SemanticBlockAlignmentGap[]
          | undefined;
        if (!gaps) return decorations.map(transaction.mapping, transaction.doc);
        return createAlignmentDecorations(transaction.doc, gaps);
      },
    },
    props: {
      decorations: (state) => blockAlignmentPluginKey.getState(state) ?? DecorationSet.empty,
    },
  });
}

export function setSemanticBlockAlignmentGaps(
  transaction: Transaction,
  gaps: readonly SemanticBlockAlignmentGap[],
) {
  return transaction.setMeta(blockAlignmentMeta, gaps).setMeta('addToHistory', false);
}

export function isSemanticBlockAlignmentTransaction(transaction: Transaction) {
  return transaction.getMeta(blockAlignmentMeta) !== undefined;
}

function createAlignmentDecorations(
  doc: ProseMirrorNode,
  gaps: readonly SemanticBlockAlignmentGap[],
) {
  const decorations: Decoration[] = [];
  for (const gap of gaps) {
    if (gap.height <= 0.05 || gap.nodeIndex < 0 || gap.nodeIndex >= doc.childCount) continue;
    const position = getNodeEndPosition(doc, gap.nodeIndex);
    decorations.push(
      Decoration.widget(
        position,
        () => {
          const marginCompensation = gap.marginCompensation ?? 0;
          const spacer = document.createElement('div');
          spacer.className = 'semantic-block-alignment-spacer';
          spacer.dataset.alignmentKey = gap.key;
          spacer.style.height = `${gap.height}px`;
          if (marginCompensation > 0) {
            // 顶层块原本会发生相邻垂直 margin 折叠。插入 sibling widget 后两侧
            // margin 会改为相加，用等量负 margin 抵消多出来的较小一侧。
            spacer.style.marginTop = `${-marginCompensation}px`;
          }
          spacer.setAttribute('aria-hidden', 'true');
          return spacer;
        },
        {
          side: -1,
          key: `${gap.key}:${gap.height}:${gap.marginCompensation ?? 0}`,
        },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

function getNodeEndPosition(doc: ProseMirrorNode, nodeIndex: number) {
  let position = 0;
  for (let index = 0; index <= nodeIndex; index += 1) {
    position += doc.child(index).nodeSize;
  }
  return Math.min(position, doc.content.size);
}
