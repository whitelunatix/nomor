/**
 * 从 `docxPrefix` 读取 `<!-- table | col.width: 4.2cm 4.2cm -->` 的固定列宽。
 *
 * 编辑器没有 DOCX 的页面排版引擎，但论文表格通常显式给出绝对列宽；这里把
 * CSS 长度换算成 96 DPI 像素，供 TableNodeView 覆盖自动测量结果。自动测量
 * 仍是普通 Markdown 表格的唯一来源，本模块只负责 docx 前缀。
 */
import { parseDirectiveLine } from './directiveGrammar';

const UNIT_TO_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  in: 96,
  em: 16,
  rem: 16,
};

/** 把 `4.2cm` / `12pt` / `40` 转成 CSS 像素；无效值返回 null。 */
export function cssLengthToPx(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)\s*(px|pt|cm|mm|in|em|rem)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (UNIT_TO_PX[(match[2] ?? 'px').toLowerCase()] ?? 1);
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

function readColumnWidths(prefix: unknown): string[] | null {
  if (!Array.isArray(prefix)) return null;
  let widths: string[] | null = null;
  for (const raw of prefix) {
    const directive = parseDirectiveLine(String(raw));
    if (!directive || directive.canonicalKeyword !== 'table') continue;
    for (const group of directive.groups) {
      if (group.canonicalKeyword !== 'table' && group.canonicalKeyword !== 'global') continue;
      for (const field of group.fields) {
        const name = normalizeFieldName(field.canonicalName || field.rawName);
        if (name !== 'col.width' && name !== 'column.width' && name !== 'colwidths') continue;
        const values = field.value
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (values.length) widths = values;
      }
    }
  }
  return widths;
}

/** 把 `col.width` 的字符串列表换算成像素；任一值无效时返回 null。 */
export function columnWidthsToPx(values: readonly string[] | null | undefined): number[] | null {
  if (!values?.length) return null;
  const widths = values.map(cssLengthToPx);
  if (widths.some((width) => width === null)) return null;
  return widths as number[];
}

/**
 * 返回表格固定列宽（像素）。没有 `table` 指令或没有 `col.width` 时返回 null，
 * 交给原有的自动测量流程。
 *
 * 只读取字面指令；`use` / `var` 展开后的列宽由
 * `resolveTableColumnWidths(doc, table)` 提供。
 */
export function docxTableColumnWidths(prefix: unknown): number[] | null {
  return columnWidthsToPx(readColumnWidths(prefix));
}
