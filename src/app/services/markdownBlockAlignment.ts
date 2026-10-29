import { getMarkdownBlockLineMap } from '../../lib/editor-core/markdown';
import { extractFrontMatterBlock } from '../../lib/markdown/frontMatter';

export interface BlockAlignmentAnchor {
  key: string;
  nodeIndex: number;
  fromLine: number;
  toLine: number;
}

export interface BlockNaturalGeometry {
  key: string;
  top: number;
  nextTop: number;
  existingGap: number;
}

export interface BlockAlignmentGap {
  key: string;
  sourceGap: number;
  semanticGap: number;
}

export interface BlockAlignmentResult {
  status: 'ready' | 'fallback' | 'superseded';
  generation: number;
  gaps: BlockAlignmentGap[];
}

const DEFAULT_PIXEL_TOLERANCE = 1;

/**
 * 建立源码行与语义顶层节点的稳定对应关系。Front Matter 不属于
 * ProseMirror 文档，因此使用 -1；解析器追加的尾部空段落作为 EOF 合成块。
 */
export function createBlockAlignmentAnchors(
  markdown: string,
  semanticBlockCount: number,
): BlockAlignmentAnchor[] {
  const anchors: BlockAlignmentAnchor[] = [];
  const frontMatter = extractFrontMatterBlock(markdown);
  if (frontMatter) {
    anchors.push({
      key: 'front-matter',
      nodeIndex: -1,
      fromLine: 1,
      toLine: countLines(frontMatter.raw.replace(/(?:\r?\n)$/, '')),
    });
  }

  const mappings = getMarkdownBlockLineMap(markdown);
  if (semanticBlockCount !== mappings.length && semanticBlockCount !== mappings.length + 1) {
    return [];
  }
  if (!hasValidSourceRanges(mappings, countLines(markdown))) {
    return [];
  }
  anchors.push(
    ...mappings.map((mapping) => ({
      key: `node:${mapping.nodeIndex}`,
      nodeIndex: mapping.nodeIndex,
      fromLine: mapping.fromLine,
      toLine: mapping.toLine,
    })),
  );

  if (semanticBlockCount === mappings.length + 1) {
    const eofLine = countLines(markdown);
    anchors.push({
      key: 'eof',
      nodeIndex: semanticBlockCount - 1,
      fromLine: eofLine,
      toLine: eofLine,
    });
  }

  return anchors;
}

/**
 * 每个 geometry 表示一个块从自身起点推进到下一块起点的距离。
 * previous spacer 已体现在 nextTop 中，计算自然高度时必须先扣除，
 * 否则 ResizeObserver 会把上一轮补偿再次当成正文高度并形成反馈循环。
 */
export function calculateBlockAlignmentGaps(
  source: BlockNaturalGeometry[],
  semantic: BlockNaturalGeometry[],
  generation: number,
  tolerance = DEFAULT_PIXEL_TOLERANCE,
): BlockAlignmentResult {
  if (
    source.length === 0 ||
    source.length !== semantic.length ||
    source.some((item, index) => item.key !== semantic[index]?.key) ||
    !source.every(isValidGeometry) ||
    !semantic.every(isValidGeometry)
  ) {
    return { status: 'fallback', generation, gaps: [] };
  }

  const gaps = source.map((sourceGeometry, index): BlockAlignmentGap => {
    const semanticGeometry = semantic[index];
    const sourceNaturalHeight = getNaturalAdvance(sourceGeometry);
    const semanticNaturalHeight = getNaturalAdvance(semanticGeometry);
    const difference = sourceNaturalHeight - semanticNaturalHeight;

    if (Math.abs(difference) <= tolerance) {
      return { key: sourceGeometry.key, sourceGap: 0, semanticGap: 0 };
    }

    return difference > 0
      ? {
          key: sourceGeometry.key,
          sourceGap: 0,
          semanticGap: roundPixel(difference),
        }
      : {
          key: sourceGeometry.key,
          sourceGap: roundPixel(-difference),
          semanticGap: 0,
        };
  });

  return { status: 'ready', generation, gaps };
}

/**
 * 根据已经落地后的相邻锚点残差修正当前补偿。
 *
 * 这里不能再次把 existingGap 当作已经 1:1 反映到布局中的高度：CodeMirror
 * 的块级 widget 在虚拟布局重算期间，申请高度与本轮锚点推进量可能暂时不同。
 * 相邻起点误差直接描述了本轮真正剩余的推进差，因此在当前“源码减语义”
 * 净补偿上减去该残差即可；后续轮次会继续收敛尚未落地的部分。
 */
export function correctBlockAlignmentGapsFromResiduals(
  source: BlockNaturalGeometry[],
  semantic: BlockNaturalGeometry[],
  currentGaps: BlockAlignmentGap[],
  generation: number,
  tolerance = DEFAULT_PIXEL_TOLERANCE,
): BlockAlignmentResult {
  if (
    source.length === 0 ||
    source.length !== semantic.length ||
    source.length !== currentGaps.length ||
    source.some(
      (item, index) =>
        item.key !== semantic[index]?.key || item.key !== currentGaps[index]?.key,
    ) ||
    !source.every(isValidGeometry) ||
    !semantic.every(isValidGeometry)
  ) {
    return { status: 'fallback', generation, gaps: [] };
  }

  const gaps = source.map((geometry, index): BlockAlignmentGap => {
    if (index === source.length - 1) {
      return { key: geometry.key, sourceGap: 0, semanticGap: 0 };
    }

    const nextSource = source[index + 1];
    const currentSemantic = semantic[index];
    const nextSemantic = semantic[index + 1];
    const currentGap = currentGaps[index];
    const residualAdvance =
      nextSource.top - geometry.top - (nextSemantic.top - currentSemantic.top);
    const correctedNetGap = currentGap.sourceGap - currentGap.semanticGap - residualAdvance;

    if (Math.abs(correctedNetGap) <= tolerance) {
      return { key: geometry.key, sourceGap: 0, semanticGap: 0 };
    }

    return correctedNetGap > 0
      ? {
          key: geometry.key,
          sourceGap: roundPixel(correctedNetGap),
          semanticGap: 0,
        }
      : {
          key: geometry.key,
          sourceGap: 0,
          semanticGap: roundPixel(-correctedNetGap),
        };
  });

  return { status: 'ready', generation, gaps };
}

function getNaturalAdvance(geometry: BlockNaturalGeometry) {
  return Math.max(0, geometry.nextTop - geometry.top - geometry.existingGap);
}

function isValidGeometry(geometry: BlockNaturalGeometry) {
  return (
    Number.isFinite(geometry.top) &&
    Number.isFinite(geometry.nextTop) &&
    Number.isFinite(geometry.existingGap) &&
    geometry.nextTop >= geometry.top &&
    geometry.existingGap >= 0
  );
}

function hasValidSourceRanges(
  mappings: Array<{ nodeIndex: number; fromLine: number; toLine: number }>,
  sourceLineCount: number,
) {
  let previousToLine = 0;
  return mappings.every((mapping, index) => {
    const valid =
      mapping.nodeIndex === index &&
      Number.isInteger(mapping.fromLine) &&
      Number.isInteger(mapping.toLine) &&
      mapping.fromLine >= 1 &&
      mapping.toLine >= mapping.fromLine &&
      mapping.toLine <= sourceLineCount &&
      mapping.fromLine > previousToLine;
    previousToLine = mapping.toLine;
    return valid;
  });
}

function countLines(value: string) {
  return value.split(/\r?\n/).length;
}

function roundPixel(value: number) {
  return Math.round(value * 10) / 10;
}
