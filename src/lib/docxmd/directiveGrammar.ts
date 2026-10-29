/**
 * `.docx.md` 指令语法切分。
 *
 * 与 word-operation 的 `tools_forward/directive_syntax.py` 保持相同边界：
 * - `&` 连接多个指令分组，括号内的 `&` 不切分；
 * - `|` 分隔关键字与属性；
 * - `;` 分隔属性，括号内的 `;` 不切分（`decorators: [...]`）；
 * - 引号不是边界；值里的 `|` 只在主属性段按文档规则处理。
 *
 * 与 Python 版不同的是，切分只记录原始位置，不回写转义后的字符串，
 * 保证保存时字段逐字不变。
 */
import {
  attachOf,
  categoryOf,
  DECORATOR_TARGETS,
  canonicalFieldName,
  canonicalGroupFieldName,
  isKnownDirectiveKeyword,
} from './directiveRegistry';
import type {
  DocxAttach,
  DocxCategory,
  DocxDiagnostic,
  DocxField,
  DocxGroup,
  DocxSpan,
  ParsedDocxDirective,
} from './model';

// 关键字后面可以跟 `|` 属性列表，也可以直接跟 body（`use body` / `var x = ...`）。
const DIRECTIVE_RE = /^(@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+([\s\S]*))?$/;
const COMMENT_RE = /^\s*<!--([\s\S]*?)-->\s*$/;
const GLOBAL_RE = /^global\.([A-Za-z_]\w*)$/;

/** 只含 body 的关键字：`var foo = font | ...` 不是 `;` 属性列表。 */
const BODY_KEYWORDS = new Set(['var', 'fun', 'use', 'import', 'snippet', '/snippet']);

interface PartWithSpan {
  text: string;
  from: number;
  to: number;
}

/** 按未转义、且不在方括号内的分隔符切分，返回去空白后的绝对范围。 */
export function splitWithSpans(text: string, separator: string): PartWithSpan[] {
  const parts: PartWithSpan[] = [];
  let start = 0;
  let escaped = false;
  let bracketDepth = 0;
  const push = (from: number, to: number) => {
    let left = from;
    let right = to;
    while (left < right && /\s/.test(text[left]!)) left++;
    while (right > left && /\s/.test(text[right - 1]!)) right--;
    if (right > left) parts.push({ text: text.slice(left, right), from: left, to: right });
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === separator && bracketDepth === 0) {
      push(start, index);
      start = index + 1;
    }
  }
  push(start, text.length);
  return parts;
}

export function splitProps(rawValue: string): PartWithSpan[] {
  return splitWithSpans(rawValue, ';');
}

export function splitInstructionSegments(text: string): PartWithSpan[] {
  return splitWithSpans(text, '&');
}

/**
 * `@table.cell | position: (1, 0) & paragraph | ...` 的主属性段允许用 `|`
 * 代替 `;`。只用于表格作用域装饰器与 `@page.gutter`。
 */
const PIPE_SEPARATED_MAIN_PROPS = new Set([
  '@table.header',
  '@table.body',
  '@table.cell',
  '@table.paragraph',
  '@table.continuation',
  '@page.gutter',
]);

function normalizeTableScopeProps(rawValue: string): string {
  return rawValue.replace(/\s*\|\s*(?=[A-Za-z_][\w.]*\s*:)/g, '; ');
}

/** 判断属性段里是否有 `decorators: [...]`。 */
export function hasInlineDecoratorProperty(rawValue: string): boolean {
  return splitProps(rawValue).some((part) => {
    const colon = part.text.indexOf(':');
    return colon > 0 && part.text.slice(0, colon).trim() === 'decorators';
  });
}

/** 展开 `[...]` 内的装饰器列表，返回每项在原始值中的范围与文本。 */
export function parseDecoratorList(rawValue: string): PartWithSpan[] {
  const value = rawValue.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  const leading = rawValue.indexOf('[');
  const inner = value.slice(1, -1);
  const innerStart = leading + 1;
  const parts: PartWithSpan[] = [];
  let start = 0;
  let escaped = false;
  let bracketDepth = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === ';' && bracketDepth === 0) {
      const next = inner.slice(index + 1).search(/\S/);
      const nextIndex = next < 0 ? inner.length : index + 1 + next;
      if (nextIndex < inner.length && inner[nextIndex] === '@') {
        pushPart(parts, inner, innerStart, start, index);
        start = nextIndex;
        index = nextIndex;
      }
    }
  }
  pushPart(parts, inner, innerStart, start, inner.length);
  return parts;
}

function pushPart(parts: PartWithSpan[], inner: string, innerStart: number, from: number, to: number) {
  let left = from;
  let right = to;
  while (left < right && /\s/.test(inner[left]!)) left++;
  while (right > left && /\s/.test(inner[right - 1]!)) right--;
  if (right > left) {
    parts.push({ text: inner.slice(left, right), from: innerStart + left, to: innerStart + right });
  }
}

interface ParsedSegment {
  rawKeyword: string;
  keyword: string;
  globalTarget: string | null;
  /** 关键字之后、`|` 之前的原始正文（已 trim）。 */
  body: string;
  rawValue: string;
  valueStart: number;
  valueEnd: number;
  groupSpan: DocxSpan;
}

function parseSegment(segment: PartWithSpan, content: string): ParsedSegment | null {
  const match = DIRECTIVE_RE.exec(segment.text);
  if (!match) return null;
  const rawKeyword = match[1]!;
  let keyword = rawKeyword;
  let globalTarget: string | null = null;
  const globalMatch = GLOBAL_RE.exec(keyword);
  if (globalMatch) {
    globalTarget = globalMatch[1]!;
    keyword = 'global';
  }
  const keywordOffset = segment.from;
  const pipeIndex = segment.text.indexOf('|');
  const afterKeyword = segment.text.slice(rawKeyword.length).trim();
  const body = afterKeyword.startsWith('|') ? afterKeyword.slice(1).trim() : afterKeyword;
  let rawValue = '';
  let valueStart = keywordOffset + segment.text.length;
  if (pipeIndex >= 0) {
    const afterPipe = segment.text.slice(pipeIndex + 1);
    const leading = afterPipe.length - afterPipe.trimStart().length;
    rawValue = afterPipe.slice(leading).trimEnd();
    valueStart = keywordOffset + pipeIndex + 1 + leading;
  }
  const valueEnd = valueStart + rawValue.length;
  void content;
  return {
    rawKeyword,
    keyword,
    globalTarget,
    body,
    rawValue,
    valueStart,
    valueEnd,
    groupSpan: { from: segment.from, to: segment.to },
  };
}

function parseFields(
  segment: ParsedSegment,
  content: string,
  keywordForAliases: string,
): DocxField[] {
  if (BODY_KEYWORDS.has(segment.keyword)) return [];
  if (!segment.rawValue) return [];
  let rawValue = segment.rawValue;
  let valueStart = segment.valueStart;
  if (PIPE_SEPARATED_MAIN_PROPS.has(segment.rawKeyword)) {
    const normalized = normalizeTableScopeProps(rawValue);
    if (normalized !== rawValue) {
      // 规范化只用于切分；字段范围仍映射回原文，值取自原文切片。
      rawValue = normalized;
      valueStart = segment.valueStart;
    }
  }
  const parts = splitWithSpans(rawValue, ';');
  const fields: DocxField[] = [];
  for (const part of parts) {
    const colon = part.text.indexOf(':');
    const absoluteFrom = valueStart + part.from;
    const absoluteTo = valueStart + part.to;
    if (colon < 0) {
      fields.push({
        rawName: part.text,
        canonicalName: canonicalFieldName(keywordForAliases, part.text),
        rawValue: '',
        value: '',
        fieldSpan: { from: absoluteFrom, to: absoluteTo },
        valueSpan: { from: absoluteFrom, to: absoluteTo },
      });
      continue;
    }
    const rawName = part.text.slice(0, colon).trim();
    let valueFromInPart = colon + 1;
    while (valueFromInPart < part.text.length && /\s/.test(part.text[valueFromInPart]!)) valueFromInPart++;
    let valueToInPart = part.text.length;
    while (valueToInPart > valueFromInPart && /\s/.test(part.text[valueToInPart - 1]!)) valueToInPart--;
    const fieldValue = part.text.slice(valueFromInPart, valueToInPart);
    fields.push({
      rawName,
      canonicalName: canonicalFieldName(keywordForAliases, rawName),
      rawValue: fieldValue,
      value: fieldValue,
      fieldSpan: { from: absoluteFrom, to: absoluteTo },
      valueSpan: {
        from: absoluteFrom + valueFromInPart,
        to: absoluteFrom + valueToInPart,
      },
    });
  }
  void content;
  return fields;
}

function keywordForFieldAliases(segment: ParsedSegment): string {
  if (segment.keyword === 'global') return segment.globalTarget ?? 'global';
  if (segment.rawKeyword.startsWith('@') && segment.rawKeyword.startsWith('@image.')) return 'image_decorator';
  if (segment.rawKeyword === '@table.header' || segment.rawKeyword === '@table.body'
    || segment.rawKeyword === '@table.cell' || segment.rawKeyword === '@table.paragraph'
    || segment.rawKeyword === '@table.continuation') return 'table';
  if (segment.rawKeyword === '@list.numbering' || segment.rawKeyword === '@heading.numbering') return 'numbering';
  if (segment.rawKeyword === '@toc.entry' || /^@toc\.h[1-9]$/.test(segment.rawKeyword)) return 'paragraph';
  if (segment.rawKeyword === '@page.gutter') return 'page';
  return segment.keyword;
}

/** 解析注释内部正文；未知关键字返回 null，交给普通注释渲染。 */
export function parseDirectiveContent(content: string): ParsedDocxDirective | null {
  if (!content || /[\r\n]/.test(content)) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  const segments = splitInstructionSegments(trimmed);
  if (segments.length === 0) return null;
  const main = parseSegment(segments[0]!, content);
  if (!main) return null;
  if (!isKnownDirectiveKeyword(main.rawKeyword) && !isKnownDirectiveKeyword(main.keyword)) return null;

  const diagnostics: DocxDiagnostic[] = [];
  const groups: DocxGroup[] = [];
  const inlineDecorators: ParsedDocxDirective[] = [];
  const body = main.body;

  segments.forEach((segment, index) => {
    const parsed = index === 0 ? main : parseSegment(segment, content);
    if (!parsed) {
      diagnostics.push({
        code: 'DOCX_GROUP_SYNTAX',
        severity: 'warning',
        message: `无法解析指令分组：${segment.text}`,
      });
      return;
    }
    if (!isKnownDirectiveKeyword(parsed.rawKeyword) && !isKnownDirectiveKeyword(parsed.keyword)) {
      diagnostics.push({
        code: 'DOCX_UNKNOWN_DIRECTIVE',
        severity: 'warning',
        message: `未知的指令关键字：${parsed.rawKeyword}`,
        field: parsed.rawKeyword,
      });
    }
    const fields = parseFields(parsed, content, keywordForFieldAliases(parsed));
    groups.push({
      rawKeyword: parsed.rawKeyword,
      canonicalKeyword: parsed.keyword,
      globalTarget: parsed.globalTarget,
      body: parsed.body,
      fields,
      span: parsed.groupSpan,
    });

    if (index === 0 && hasInlineDecoratorProperty(parsed.rawValue)) {
      const decoratorField = fields.find((field) => field.rawName === 'decorators');
      if (decoratorField) {
        for (const item of parseDecoratorList(decoratorField.rawValue)) {
          const decorator = parseDirectiveContent(item.text);
          if (decorator) inlineDecorators.push(decorator);
          else {
            diagnostics.push({
              code: 'DOCX_DECORATOR_SYNTAX',
              severity: 'warning',
              message: `无法解析内联装饰器：${item.text}`,
            });
          }
        }
      }
    }
  });

  if (!groups.length) return null;

  const attach: DocxAttach = attachOf(main.keyword, main.globalTarget);
  const category: DocxCategory = categoryOf(main.keyword, main.globalTarget);
  const decorator = main.rawKeyword.startsWith('@');

  // 装饰器能力校验（轻量）：只提示，不改写原文。
  if (hasInlineDecoratorProperty(main.rawValue) && !DECORATOR_TARGETS[main.keyword]) {
    diagnostics.push({
      code: 'DOCX_DECORATOR_NOT_ALLOWED',
      severity: 'warning',
      message: `指令 ${main.rawKeyword} 不支持 decorators 列表。`,
    });
  }

  const contentStart = content.indexOf(trimmed);
  return {
    raw: content,
    content,
    contentStart,
    body,
    keyword: main.rawKeyword,
    canonicalKeyword: main.keyword,
    globalTarget: main.globalTarget,
    decorator,
    category,
    attach,
    groups,
    inlineDecorators,
    diagnostics,
  };
}

/**
 * 解析一整行 HTML 注释。只有严格单行、且关键字已知的注释才算 docx 指令。
 * 普通 Markdown 注释继续走现有 comment chip 渲染。
 */
export function parseDirectiveLine(rawLine: string): ParsedDocxDirective | null {
  const match = COMMENT_RE.exec(rawLine);
  if (!match) return null;
  const inner = match[1] ?? '';
  if (/[\r\n]/.test(inner)) return null;
  const parsed = parseDirectiveContent(inner);
  if (!parsed) return null;

  const open = rawLine.indexOf('<!--');
  const contentStart = open + 4;
  // 保留注释内部原始空白；content 是 inner 的原始切片。
  const content = inner;
  const leadingWhitespace = content.length - content.trimStart().length;
  return {
    ...parsed,
    raw: rawLine,
    content,
    contentStart: contentStart + leadingWhitespace,
    body: parsed.body,
  };
}

/** 取规范化关键字；`global.font` → `global`。 */
export function canonicalKeywordOf(directive: ParsedDocxDirective): string {
  return directive.canonicalKeyword;
}
