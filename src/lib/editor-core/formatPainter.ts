/**
 * 格式刷的行内格式计划。
 *
 * 复制端只保留 mark 的「有/无」，粘贴端把它当作目标状态：
 * 目标多出来的格式需要移除，缺少的格式需要补上。上标/下标互斥，
 * 因此调用方必须先执行 `toRemove` 再执行 `toApply`。
 */

import type { InlinePendingMarkName } from './types';

/** 格式刷覆盖的 mark；顺序同时决定应用顺序。 */
export const FORMAT_PAINTER_NAMES: readonly InlinePendingMarkName[] = [
  'strong',
  'em',
  'underline',
  'strikethrough',
  'highlight',
  'superscript',
  'subscript',
  'code',
];

export interface FormatPainterPlan {
  toRemove: InlinePendingMarkName[];
  toApply: InlinePendingMarkName[];
}

export function planFormatPainter(
  desiredMarks: Iterable<InlinePendingMarkName>,
  isActive: (name: InlinePendingMarkName) => boolean,
): FormatPainterPlan {
  const desired = new Set(desiredMarks);
  const plan: FormatPainterPlan = { toRemove: [], toApply: [] };
  for (const name of FORMAT_PAINTER_NAMES) {
    const active = isActive(name);
    if (active && !desired.has(name)) plan.toRemove.push(name);
    else if (!active && desired.has(name)) plan.toApply.push(name);
  }
  return plan;
}
