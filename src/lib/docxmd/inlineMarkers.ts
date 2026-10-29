/**
 * `.docx.md` 行内标记。
 *
 * 官方语法只有两类：
 * - 成对范围：`[[NEW | & font | ...]]...[[/NEW]]`（TBL/FIG/EQ/REF/CMT/INS/DEL 同理）；
 * - 点锚点：`[[BR]]`、`[[TAB]]`、`[[FN | content:"..."]]`、`[[EN | ...]]`、`[[SLOT 名字]]`。
 *
 * 本模块只做原文切分，不改写任何字符。字段值里的 `;`、`|`、`&` 放在引号内时
 * 按普通字符处理；未闭合、未知关键字都返回 null，让上层保留字面文本。
 */
import type { DocxField, DocxSpan } from './model';

export type DocxInlineRole = 'open' | 'close' | 'atom';

export interface DocxInlineGroup {
  /** 已转小写的组关键字；首个组就是标记类型本身（new/ref/...）。 */
  keyword: string;
  /** `use 名称` 等没有属性列表时的正文。 */
  body: string;
  fields: DocxField[];
  raw: string;
}

export interface ParsedDocxInlineMarker {
  role: DocxInlineRole;
  /** 大写标记类型，例如 NEW、REF、FN。 */
  kind: string;
  /** 完整原文，含 `[[` 与 `]]`。 */
  raw: string;
  /** `[[` 与 `]]` 之间的原文（未 trim）。 */
  inner: string;
  groups: DocxInlineGroup[];
  /** 点锚点的内容/名称等语义值。 */
  name: string | null;
  content: string | null;
  author: string | null;
  initials: string | null;
  status: string | null;
  date: string | null;
}

/** 成对范围标记。 */
const PAIRED_KINDS = new Set(['NEW', 'CMT', 'TBL', 'FIG', 'EQ', 'REF', 'INS', 'DEL']);

/** 点锚点。 */
const ATOM_KINDS = new Set(['BR', 'TAB', 'FN', 'EN', 'SLOT']);

/** 允许在表格行里保护内部 `|` 的标记类型。 */
const KNOWN_KINDS = new Set([...PAIRED_KINDS, ...ATOM_KINDS]);

const KIND_RE = /^[A-Za-z][A-Za-z0-9_]*/;

function isKnownKind(kind: string): boolean {
  return PAIRED_KINDS.has(kind) || ATOM_KINDS.has(kind);
}

function span(from: number, to: number): DocxSpan {
  return { from, to };
}

/** 按分隔符切分，忽略引号和 `[...]` 内的分隔符；返回已 trim 的片段。 */
function splitOutsideQuotes(text: string, separator: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  let bracketDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (char === separator && bracketDepth === 0) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

function findOutsideQuotes(text: string, needle: string): number {
  let quote: string | null = null;
  let escaped = false;
  let bracketDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      continue;
    }
    if (char === needle && bracketDepth === 0) return index;
  }
  return -1;
}

/** 去掉成对引号；仅用于显示与语义读取，原文仍保存在 raw/rawValue。 */
export function unquoteMarkerValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  return trimmed;
}

function readFields(raw: string): DocxField[] {
  const fields: DocxField[] = [];
  for (const part of splitOutsideQuotes(raw, ';')) {
    const colon = findOutsideQuotes(part, ':');
    const rawName = (colon >= 0 ? part.slice(0, colon) : part).trim();
    if (!rawName) continue;
    const rawValue = colon >= 0 ? part.slice(colon + 1).trim() : '';
    fields.push({
      rawName,
      canonicalName: rawName.toLowerCase(),
      rawValue,
      value: unquoteMarkerValue(rawValue),
      fieldSpan: span(0, part.length),
      valueSpan: span(0, rawValue.length),
    });
  }
  return fields;
}

/** `use bullet` / `import 名称` 这类没有 `|` 的组关键字。 */
const BODY_GROUP_KEYWORDS = new Set(['use', 'import']);

/** 读取 `font | a: b; c: d` 这类组；没有属性列表时保留正文。 */
function readGroup(segment: string, fallbackKeyword: string): DocxInlineGroup | null {
  const text = segment.trim();
  if (!text) return null;
  const pipe = findOutsideQuotes(text, '|');
  const head = (pipe >= 0 ? text.slice(0, pipe) : text).trim();
  const body = pipe >= 0 ? text.slice(pipe + 1).trim() : '';
  const headMatch = KIND_RE.exec(head);
  const explicitKeyword = headMatch && headMatch[0] === head ? head.toLowerCase() : null;
  const bodyKeyword = pipe < 0 ? headMatch?.[0].toLowerCase() : null;
  if (!explicitKeyword && bodyKeyword && BODY_GROUP_KEYWORDS.has(bodyKeyword)) {
    return {
      keyword: bodyKeyword,
      body: head.slice(headMatch![0].length).trim(),
      fields: [],
      raw: text,
    };
  }
  if (!explicitKeyword && pipe < 0) {
    // 只有字段（`id:"1"`）时归属于标记类型本身。
    return {
      keyword: fallbackKeyword,
      body: '',
      fields: readFields(head),
      raw: text,
    };
  }
  return {
    keyword: explicitKeyword ?? fallbackKeyword,
    body: '',
    fields: readFields(body),
    raw: text,
  };
}

function readAtomFields(raw: string, fallbackKeyword: string): DocxInlineGroup[] {
  const groups: DocxInlineGroup[] = [];
  const segments = splitOutsideQuotes(raw, '&');
  for (const segment of segments) {
    const group = readGroup(segment, fallbackKeyword);
    if (group) groups.push(group);
  }
  return groups;
}

/**
 * 解析 `[[ ... ]]` 内部语法。
 *
 * @param inner 两个 `[[` 与 `]]` 之间的原文。
 */
export function parseInlineMarker(inner: string): ParsedDocxInlineMarker | null {
  if (!inner || /[\r\n]/.test(inner)) return null;
  const text = inner.trim();
  if (!text) return null;

  if (text.startsWith('/')) {
    const kindText = text.slice(1).trim();
    const match = KIND_RE.exec(kindText);
    if (!match || match[0] !== kindText) return null;
    const kind = kindText.toUpperCase();
    if (!PAIRED_KINDS.has(kind)) return null;
    return {
      role: 'close',
      kind,
      raw: `[[${inner}]]`,
      inner,
      groups: [],
      name: null,
      content: null,
      author: null,
      initials: null,
      status: null,
      date: null,
    };
  }

  const match = KIND_RE.exec(text);
  if (!match) return null;
  const kind = match[0].toUpperCase();
  if (!isKnownKind(kind)) return null;
  const rest = text.slice(match[0].length).trim();

  const base: ParsedDocxInlineMarker = {
    role: 'open',
    kind,
    raw: `[[${inner}]]`,
    inner,
    groups: [],
    name: null,
    content: null,
    author: null,
    initials: null,
    status: null,
    date: null,
  };

  if (ATOM_KINDS.has(kind)) {
    base.role = 'atom';
    if (kind === 'SLOT') {
      base.name = unquoteMarkerValue(rest);
      return base;
    }
    base.groups = readAtomFields(rest, kind.toLowerCase());
    const kindFields = base.groups.find((group) => group.keyword === kind.toLowerCase());
    const read = (name: string): string | null => {
      const field = kindFields?.fields.find(
        (candidate) => candidate.rawName.toLowerCase() === name,
      );
      return field ? unquoteMarkerValue(field.value) : null;
    };
    base.content = read('content');
    base.name = read('name');
    return base;
  }

  // 成对标记：`NEW | & font | ...`。首个 `&` 前的部分属于标记本身。
  const segments = splitOutsideQuotes(rest, '&');
  if (segments.length === 0) {
    base.groups.push({ keyword: kind.toLowerCase(), body: '', fields: [], raw: '' });
    return base;
  }
  const [first, ...others] = segments;
  const firstGroup = readGroup(first.replace(/^\|\s*/, ''), kind.toLowerCase());
  if (firstGroup) base.groups.push(firstGroup);
  for (const segment of others) {
    const group = readGroup(segment, kind.toLowerCase());
    if (group) base.groups.push(group);
  }
  const kindFields = base.groups.find((group) => group.keyword === kind.toLowerCase());
  const idField = kindFields?.fields.find((field) => field.rawName.toLowerCase() === 'id');
  base.name = idField ? unquoteMarkerValue(idField.value) : null;
  const contentField = kindFields?.fields.find((field) => field.rawName.toLowerCase() === 'content');
  base.content = contentField ? unquoteMarkerValue(contentField.value) : null;
  for (const field of kindFields?.fields ?? []) {
    const fieldName = field.rawName.toLowerCase();
    if (fieldName === 'author') base.author = unquoteMarkerValue(field.value);
    else if (fieldName === 'initials') base.initials = unquoteMarkerValue(field.value);
    else if (fieldName === 'status') base.status = unquoteMarkerValue(field.value);
    else if (fieldName === 'date') base.date = unquoteMarkerValue(field.value);
  }
  return base;
}

/** 该 `[[...]]` 是否是编辑器认识的标记；用于保护表格行里的 `|`。 */
export function isKnownInlineMarker(inner: string): boolean {
  return parseInlineMarker(inner) !== null;
}

export interface DocxInlineRuleState {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): {
    content: string;
    markup: string;
    meta: Record<string, unknown>;
  };
}

function countMarker(source: string, kind: string, closing: boolean): number {
  const pattern = closing
    ? new RegExp(`\\[\\[\\s*/\\s*${kind}\\s*\\]\\]`, 'gi')
    : new RegExp(`\\[\\[\\s*${kind}(?=\\s|\\||\\]\\])`, 'gi');
  return Array.from(source.matchAll(pattern)).length;
}

/**
 * markdown-it 行内规则：把 `[[...]]` 变成结构 token。
 *
 * 未闭合的开标记与没有对应开标记的闭标记都保留为字面原子
 * （`valid: false`），既不吞正文，也不在渲染层静默消失。
 */
export function docxInlineRule(state: DocxInlineRuleState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  if (start + 3 >= state.posMax) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0 || end + 2 > state.posMax) return false;
  const inner = src.slice(start + 2, end);
  // 表格行保护把 `|` 换成了私有字符；解析语义前先还原，原文范围不受影响。
  const parsed = parseInlineMarker(inner.split(DOCX_INLINE_PIPE_MARKER).join('|'));
  if (!parsed) return false;

  let role = parsed.role;
  let valid = true;
  if (parsed.role === 'open') {
    const rest = src.slice(end + 2, state.posMax);
    const closing = new RegExp(`\\[\\[\\s*/\\s*${parsed.kind}\\s*\\]\\]`, 'i');
    if (!closing.test(rest)) {
      role = 'atom';
      valid = false;
    }
  } else if (parsed.role === 'close') {
    const before = src.slice(0, start);
    if (countMarker(before, parsed.kind, false) <= countMarker(before, parsed.kind, true)) {
      role = 'atom';
      valid = false;
    }
  }

  if (silent) {
    state.pos = end + 2;
    return true;
  }

  const type = role === 'open'
    ? 'docx_inline_open'
    : role === 'close'
      ? 'docx_inline_close'
      : 'docx_inline_atom';
  const token = state.push(type, '', 0);
  token.content = parsed.raw;
  token.markup = role === 'close' ? ']]' : '[[';
  token.meta = {
    docxInlineMarker: parsed,
    docxInlineValid: valid,
    // 规则自己记录精确范围；recordInlineSourceRanges 会保留它。
    inlineSourceRange: { from: start, to: end + 2 },
    inlineSourcePoint: start,
  };
  state.pos = end + 2;
  return true;
}

/** 只把已知标记内部的 `|` 替换成占位符，长度不变，便于恢复。 */
export const DOCX_INLINE_PIPE_MARKER = '\uE000';

export interface RestorableToken {
  content: string;
  attrs?: Array<[string, string]> | null;
  meta?: Record<string, unknown> | null;
  children?: RestorableToken[] | null;
}

function restoreValue(value: unknown, seen: Set<unknown>, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return value.split(DOCX_INLINE_PIPE_MARKER).join('|');
  if (Array.isArray(value)) {
    return value.map((item) => restoreValue(item, seen, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      record[key] = restoreValue(record[key], seen, depth + 1);
    }
    return value;
  }
  return value;
}

/** 恢复被 `maskInlineMarkerPipes` 保护的 `|`；长度不变，源码范围仍然有效。 */
export function restoreInlineMarkerPipesInTokens<T extends RestorableToken>(tokens: T[]): T[] {
  const seen = new Set<unknown>();
  const visit = (token: RestorableToken) => {
    token.content = token.content.split(DOCX_INLINE_PIPE_MARKER).join('|');
    if (token.attrs) {
      // markdown-it 的 attr 值不一定是字符串（例如有序列表的 `start` 是数字），
      // 只有字符串里才可能含被替换的竖线占位符。
      for (const attr of token.attrs) {
        if (typeof attr[1] === 'string') {
          attr[1] = attr[1].split(DOCX_INLINE_PIPE_MARKER).join('|');
        }
      }
    }
    if (token.meta) restoreValue(token.meta, seen, 0);
    for (const child of token.children ?? []) visit(child);
  };
  for (const token of tokens) visit(token);
  return tokens;
}

/** 成对标记正文里的 `|` 对 Markdown 表格是文字，不是列分隔符。 */
function maskPipes(text: string): string {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '|' && text[index - 1] !== '\\') {
      output += DOCX_INLINE_PIPE_MARKER;
    } else {
      output += char;
    }
  }
  return output;
}

/**
 * 保护 `[[NEW | ...]]...[[/NEW]]` 内部的 `|`。
 *
 * 生成器（`main_forward_go`）在切分表格行时把成对标记当作整体，正文里的
 * 竖线是文字；编辑器必须用同一规则，否则 `电话… | 邮箱…` 这种单元格会被
 * 拆成额外列，整行退化成普通段落。`\|` 交给 Markdown 自己的转义处理，
 * 这里不能替换，否则反斜杠会残留在正文里。
 */
export function maskInlineMarkerPipes(source: string): string {
  if (!source.includes('[[')) return source;
  let output = '';
  let cursor = 0;
  const stack: string[] = [];
  while (cursor < source.length) {
    const start = source.indexOf('[[', cursor);
    if (start < 0) {
      output += stack.length ? maskPipes(source.slice(cursor)) : source.slice(cursor);
      break;
    }
    output += stack.length ? maskPipes(source.slice(cursor, start)) : source.slice(cursor, start);
    const end = source.indexOf(']]', start + 2);
    if (end < 0) {
      output += stack.length ? maskPipes(source.slice(start)) : source.slice(start);
      break;
    }
    const inner = source.slice(start + 2, end);
    const marker = parseInlineMarker(inner);
    if (!marker) {
      output += stack.length ? maskPipes(source.slice(start, end + 2)) : source.slice(start, end + 2);
    } else {
      if (marker.role === 'close' && stack.length) stack.pop();
      output += `[[${inner.replace(/\|/g, DOCX_INLINE_PIPE_MARKER)}]]`;
      if (marker.role === 'open' && hasClosingMarker(source.slice(end + 2), marker.kind)) {
        stack.push(marker.kind);
      }
    }
    cursor = end + 2;
  }
  return output;
}

/** 与 `docxInlineRule` 一致：只有真的存在闭标记时才进入成对范围。 */
function hasClosingMarker(rest: string, kind: string): boolean {
  return new RegExp(`\\[\\[\\s*/\\s*${kind}\\s*\\]\\]`, 'i').test(rest);
}
