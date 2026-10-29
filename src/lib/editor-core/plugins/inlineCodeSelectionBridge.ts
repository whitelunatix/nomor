import { Plugin } from 'prosemirror-state';
import type { Mark, Node as ProseMirrorNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { analyzeInlineSource, isInlineSourceBlock } from '../InlineSourceCodec';
import { createLineSelectionPaint } from '../../typography/selectionPaint';

const SELECTION_BRIDGE_CLASS = 'pm-inline-selection-bridge';
const CODE_BRIDGE_CLASS = 'pm-inline-code-selection-bridge';
const ATOM_BRIDGE_CLASS = 'pm-inline-atom-selection-bridge';
const SELECTION_ATOM_TYPES = new Set(['math_inline', 'comment_inline', 'footnote_ref', 'image']);

type CodeRange = {
  from: number;
  to: number;
};
const codeRangesByDoc = new WeakMap<ProseMirrorNode, CodeRange[]>();
const atomRangesByDoc = new WeakMap<ProseMirrorNode, CodeRange[]>();

/**
 * 正文、行内代码与原子对象的选区背景桥接插件。
 *
 * 浏览器原生选区只绘制字形区域，行内 code 的 padding/border 会把选区切断。
 * 这里给真实选区加一层可控背景，选中 code 时只调整背景和边框颜色，保留字体及尺寸。
 * 原子对象使用外层背景包住自身外边距，避免选中时改变对象尺寸或正文位置。
 * 绘制器以 data-nomo-selection-active 统一控制桥接和行背景；失焦时保留模型选区供工具栏使用。
 */
export function inlineCodeSelectionBridgePlugin(): Plugin<DecorationSet> {
  return new Plugin({
    state: {
      init(_, state) {
        codeRangesByDoc.set(state.doc, findCodeRanges(state.doc));
        return buildInlineCodeSelectionBridgeDecorations(
          state.doc,
          state.selection.from,
          state.selection.to,
        );
      },
      apply(tr, value, _oldState, newState) {
        // 代码区间只在“有选区”时才用于绘制；打字时选区为空，先不算（整篇扫描约 1 ms/键）。
        if (tr.docChanged && !newState.selection.empty) {
          codeRangesByDoc.set(newState.doc, findCodeRanges(newState.doc));
        }
        if (tr.docChanged || tr.selectionSet) {
          return buildInlineCodeSelectionBridgeDecorations(
            newState.doc,
            newState.selection.from,
            newState.selection.to,
          );
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
    view(view) {
      const paint = createLineSelectionPaint(view.dom);
      return { update: paint.schedule, destroy: paint.destroy };
    },
  });
}

function buildInlineCodeSelectionBridgeDecorations(
  doc: ProseMirrorNode,
  selectionFrom: number,
  selectionTo: number,
): DecorationSet {
  if (selectionFrom === selectionTo) {
    return DecorationSet.empty;
  }

  const from = Math.min(selectionFrom, selectionTo);
  const to = Math.max(selectionFrom, selectionTo);
  const decorations: Decoration[] = [];
  // 打字期间没有选区，代码/原子区间不会提前计算；真正需要绘制时补算一次并按文档缓存。
  const codeRanges = codeRangesByDoc.get(doc) ?? findCodeRanges(doc);
  const atoms = atomRangesByDoc.get(doc) ?? [];
  let textFrom = from;
  for (let i = firstOverlappingRange(atoms, from); i < atoms.length && atoms[i].from < to; i++) {
    const atom = atoms[i];
    if (atom.from < from || atom.to > to) continue;
    if (textFrom < atom.from)
      decorations.push(Decoration.inline(textFrom, atom.from, { class: SELECTION_BRIDGE_CLASS }));
    decorations.push(
      Decoration.node(atom.from, atom.to, {
        nodeName: 'span',
        class: `${SELECTION_BRIDGE_CLASS} ${ATOM_BRIDGE_CLASS}`,
      }),
    );
    textFrom = atom.to;
  }
  if (textFrom < to)
    decorations.push(Decoration.inline(textFrom, to, { class: SELECTION_BRIDGE_CLASS }));

  const ranges = codeRanges;
  for (let i = firstOverlappingRange(ranges, from); i < ranges.length && ranges[i].from < to; i++) {
    const range = ranges[i];
    const overlap = getSelectionOverlap(range, from, to);
    if (!overlap) continue;
    decorations.push(
      Decoration.inline(overlap.from, overlap.to, {
        class: CODE_BRIDGE_CLASS,
      }),
    );
  }

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function findCodeRanges(doc: ProseMirrorNode): CodeRange[] {
  const ranges: CodeRange[] = [];
  const atoms: CodeRange[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'html_block' || node.type.spec.code) return false;
    if (
      node.isInline &&
      SELECTION_ATOM_TYPES.has(node.type.name) &&
      !(node.type.name === 'image' && node.attrs.align)
    ) {
      atoms.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    if (isInlineSourceBlock(node)) {
      for (const span of analyzeInlineSource(node).spans) {
        if (span.type === 'code') ranges.push({ from: pos + 1 + span.from, to: pos + 1 + span.to });
      }
    }
    if (!node.isText || !node.text || !hasCodeMark(node.marks)) return true;

    const from = pos;
    const to = pos + node.nodeSize;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.to === from) {
      previous.to = to;
      return true;
    }

    ranges.push({ from, to });
    return true;
  });

  atomRangesByDoc.set(doc, atoms);
  return ranges.sort((a, b) => a.from - b.from);
}

function firstOverlappingRange(ranges: readonly CodeRange[], from: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hasCodeMark(marks: readonly Mark[]): boolean {
  return marks.some((mark) => mark.type.name === 'code');
}

function getSelectionOverlap(
  range: CodeRange,
  selectionFrom: number,
  selectionTo: number,
): CodeRange | null {
  const from = Math.max(range.from, selectionFrom);
  const to = Math.min(range.to, selectionTo);
  return from < to ? { from, to } : null;
}
