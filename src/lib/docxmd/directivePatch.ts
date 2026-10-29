/**
 * `.docx.md` 指令的精确改写。
 *
 * 属性面板只替换目标字段的值区间，保留别名、分组顺序、空格与引号；
 * 只有整行替换/新增才允许写入规范文本。任何会让指令失效的编辑都会被拒绝。
 */
import { parseDirectiveLine } from './directiveGrammar';
import type { ParsedDocxDirective } from './model';

export type DocxEdit =
  | {
      type: 'setField';
      lineIndex: number;
      groupIndex: number;
      fieldIndex: number;
      value: string;
    }
  | {
      type: 'addField';
      lineIndex: number;
      groupIndex: number;
      name: string;
      value: string;
    }
  | { type: 'removeField'; lineIndex: number; groupIndex: number; fieldIndex: number }
  | { type: 'replaceDirective'; lineIndex: number; raw: string }
  | { type: 'removeDirective'; lineIndex: number }
  | { type: 'addDirective'; lineIndex: number; raw: string };

/** 值里出现分隔符时补引号，避免破坏 `;` / `&` / `|` 的切分。 */
export function formatDocxFieldValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^["'].*["']$/.test(trimmed)) return trimmed;
  if (/[;&|]/.test(trimmed)) return `"${trimmed.replace(/"/g, '\\"')}"`;
  return trimmed;
}

function applyFieldEdit(
  line: string,
  edit: Extract<DocxEdit, { type: 'setField' }>,
): string | null {
  const directive = parseDirectiveLine(line);
  const field = directive?.groups[edit.groupIndex]?.fields[edit.fieldIndex];
  if (!directive || !field) return null;
  const base = directive.contentStart;
  const absoluteStart = base + field.fieldSpan.from;
  const absoluteEnd = base + field.fieldSpan.to;
  const valueStart = base + field.valueSpan.from;
  const valueEnd = base + field.valueSpan.to;
  if (valueStart < absoluteStart || valueEnd > absoluteEnd) return null;

  const formatted = formatDocxFieldValue(edit.value);
  if (!field.rawValue) {
    // 无值开关字段（`bold`）改成 `bold: true`，保留原字段名。
    return `${line.slice(0, absoluteStart)}${field.rawName}: ${formatted}${line.slice(absoluteEnd)}`;
  }
  return `${line.slice(0, valueStart)}${formatted}${line.slice(valueEnd)}`;
}

function addField(line: string, edit: Extract<DocxEdit, { type: 'addField' }>): string | null {
  const directive = parseDirectiveLine(line);
  const group = directive?.groups[edit.groupIndex];
  if (!directive || !group || group.fields.length === 0) return null;
  const last = group.fields[group.fields.length - 1]!;
  const insertAt = directive.contentStart + last.fieldSpan.to;
  const formatted = formatDocxFieldValue(edit.value);
  return `${line.slice(0, insertAt)}; ${edit.name}: ${formatted}${line.slice(insertAt)}`;
}

function removeField(
  line: string,
  edit: Extract<DocxEdit, { type: 'removeField' }>,
): string | null {
  const directive = parseDirectiveLine(line);
  const field = directive?.groups[edit.groupIndex]?.fields[edit.fieldIndex];
  if (!directive || !field) return null;
  const base = directive.contentStart;
  let from = base + field.fieldSpan.from;
  let to = base + field.fieldSpan.to;

  // 连带删除相邻分隔符，避免留下 `;;` 或尾随 `;`。
  let before = from;
  while (before > 0 && /\s/.test(line[before - 1]!)) before -= 1;
  if (line[before - 1] === ';') {
    from = before - 1;
    while (from > 0 && /\s/.test(line[from - 1]!)) from -= 1;
  } else {
    let after = to;
    while (after < line.length && /\s/.test(line[after]!)) after += 1;
    if (line[after] === ';') {
      to = after + 1;
      while (to < line.length && /\s/.test(line[to]!)) to += 1;
    }
  }
  return `${line.slice(0, from)}${line.slice(to)}`;
}

/**
 * 应用一组面板编辑；失败（索引过期、字段不存在、改坏语法）返回 `null`。
 *
 * `lineIndex` 是指令在 `docxPrefix` / `docx_meta.rawLines` 数组中的下标。
 */
export function applyDocxEdits(
  lines: readonly string[],
  edits: readonly DocxEdit[],
): string[] | null {
  const result: Array<string | null> = [...lines];
  const insertions = new Map<number, string[]>();

  for (const edit of edits) {
    if (edit.type === 'addDirective') {
      if (edit.lineIndex < 0 || edit.lineIndex > lines.length) return null;
      if (!parseDirectiveLine(edit.raw)) return null;
      const bucket = insertions.get(edit.lineIndex) ?? [];
      bucket.push(edit.raw);
      insertions.set(edit.lineIndex, bucket);
      continue;
    }
    if (edit.lineIndex < 0 || edit.lineIndex >= lines.length) return null;
    const current = result[edit.lineIndex];
    if (current == null) return null;

    if (edit.type === 'replaceDirective') {
      if (!parseDirectiveLine(edit.raw)) return null;
      result[edit.lineIndex] = edit.raw;
      continue;
    }
    if (edit.type === 'removeDirective') {
      result[edit.lineIndex] = null;
      continue;
    }
    const patched =
      edit.type === 'setField'
        ? applyFieldEdit(current, edit)
        : edit.type === 'addField'
          ? addField(current, edit)
          : removeField(current, edit);
    if (patched == null) return null;
    // 不允许把一条有效指令改坏。
    result[edit.lineIndex] = patched;
  }

  const output: string[] = [];
  for (let index = 0; index <= result.length; index += 1) {
    for (const raw of insertions.get(index) ?? []) output.push(raw);
    if (index === result.length) break;
    const line = result[index];
    if (line != null) output.push(line);
  }
  return output;
}

/** 供面板展示：解析一行并返回指令；普通注释/失效行返回 null。 */
export function readDirectiveLine(line: string): ParsedDocxDirective | null {
  return parseDirectiveLine(line);
}
