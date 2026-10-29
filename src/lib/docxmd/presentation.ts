/**
 * `.docx.md` 基础排版呈现。
 *
 * 第一阶段只处理块级 `docxPrefix` 中的字体/段落/标题/列表指令，用
 * ProseMirror 节点装饰把解析结果挂到内容块本身。指令原文仍保存在
 * `docxPrefix`，保存时逐字写回，装饰不进入文档、不进撤销历史。
 *
 * 文档级 `global.font` / `global.paragraph` 与 `var` 定义从 `docx_meta`
 * 读取；`use name` 按定义展开。未实现的语法保持中性，不影响正文。
 */
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from 'prosemirror-transform';
import { Decoration, DecorationSet, type DecorationAttrs, type EditorView } from 'prosemirror-view';
import { parseDirectiveContent, parseDirectiveLine } from './directiveGrammar';
import type { DocxField, ParsedDocxDirective } from './model';

export interface HeadingNumberingRule {
  /** Word numbering 系列名；同一系列共享计数器。 */
  id: string;
  level: number;
  format: string;
  text: string | null;
  start: number;
  suffix: string | null;
}

export interface DocxFunctionDefinition {
  params: string[];
  /** `=` 右侧的原始模板；调用时对 `{参数名}` 做单次替换。 */
  body: string;
}

export interface DocxGlobalDefinitions {
  font: Map<string, string>;
  paragraph: Map<string, string>;
  variables: Map<string, ParsedDocxDirective[]>;
  /** `fun name(args) = ...` 定义；`use name(...)` 展开时使用。 */
  functions: Map<string, DocxFunctionDefinition>;
  /** `use` 解析结果缓存，键是调用原文（例如 `projtitle(1pt)`）。 */
  useCache: Map<string, ParsedDocxDirective[] | null>;
  /** `global.heading | decorators: [@heading.numbering ...]` 的完整系列。 */
  headingNumbering: HeadingNumberingRule[];
  /** 用于样式缓存失效。 */
  key: string;
}

const directiveCache = new Map<string, ParsedDocxDirective | null>();
const styleCache = new Map<string, ResolvedBlockPresentation | null>();

const STYLE_CACHE_LIMIT = 4000;

function parseLineCached(line: string): ParsedDocxDirective | null {
  if (directiveCache.has(line)) return directiveCache.get(line) ?? null;
  const parsed = parseDirectiveLine(line);
  directiveCache.set(line, parsed);
  if (directiveCache.size > 2000) directiveCache.clear();
  return parsed;
}

/** `var name = font | ...` / `fun name(a, b) = ...` 中 `=` 右侧的定义原文。 */
function definitionRest(directive: ParsedDocxDirective): { signature: string; body: string } | null {
  const content = directive.content;
  const keywordEnd = content.indexOf(directive.keyword);
  if (keywordEnd < 0) return null;
  const rest = content.slice(keywordEnd + directive.keyword.length);
  const equals = rest.indexOf('=');
  if (equals < 0) return null;
  return { signature: rest.slice(0, equals).trim(), body: rest.slice(equals + 1) };
}

/** `var name = font | ...` 的定义部分。 */
function parseVariableDefinition(directive: ParsedDocxDirective): {
  name: string;
  directives: ParsedDocxDirective[];
} | null {
  const rest = definitionRest(directive);
  if (!rest) return null;
  const name = rest.signature;
  if (!name) return null;
  const parsed = parseDirectiveContent(rest.body);
  return parsed ? { name, directives: [parsed] } : { name, directives: [] };
}

/** `fun name(a, b) = font | ...` 的定义部分。 */
function parseFunctionDefinition(
  directive: ParsedDocxDirective,
): ({ name: string } & DocxFunctionDefinition) | null {
  const rest = definitionRest(directive);
  if (!rest) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(([\s\S]*)\)$/.exec(rest.signature);
  if (!match) return null;
  return {
    name: match[1]!,
    params: splitArguments(match[2] ?? ''),
    body: rest.body,
  };
}

/** 按未转义的逗号切分函数实参；`\,` 表示实参内部的逗号。 */
function splitArguments(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      // 只有 `\,` 是转义逗号；其余反斜杠原样保留，避免破坏 LaTeX 实参。
      current += char === ',' ? ',' : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (current.trim() || args.length) args.push(current.trim());
  return args;
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** 参数个数不符时返回 null（与官方实现一致，不做静默补位）。 */
function renderFunctionBody(
  template: string,
  params: string[],
  args: string[],
): string | null {
  if (params.length !== args.length) return null;
  const values = new Map<string, string>();
  params.forEach((param, index) => values.set(param, args[index] ?? ''));
  return template.replace(PLACEHOLDER_RE, (match, name: string) => values.get(name) ?? match);
}

/** 解析 `use` 引用的变量或函数；结果按调用原文缓存。 */
function resolveUseDefinition(
  rawName: string,
  globals: DocxGlobalDefinitions,
): ParsedDocxDirective[] | null {
  const name = rawName.trim();
  if (!name) return null;
  const variable = globals.variables.get(name);
  if (variable) return variable;
  const cached = globals.useCache.get(name);
  if (cached !== undefined) return cached;

  let resolved: ParsedDocxDirective[] | null = null;
  const call = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(([\s\S]*)\)$/.exec(name);
  if (call) {
    const definition = globals.functions.get(call[1]!);
    const rendered = definition
      ? renderFunctionBody(definition.body, definition.params, splitArguments(call[2] ?? ''))
      : null;
    if (rendered != null) {
      const parsed = parseDirectiveContent(rendered);
      resolved = parsed ? [parsed] : null;
    }
  }
  globals.useCache.set(name, resolved);
  return resolved;
}

function readLevel(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:h)?([1-9])$/i.exec(value.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** 把 `@heading.numbering` 装饰器转成可参与文档顺序计数的规则。 */
export function headingNumberingRule(
  directive: ParsedDocxDirective,
): HeadingNumberingRule | null {
  if (directive.keyword !== '@heading.numbering') return null;
  const fields = directive.groups[0]?.fields ?? [];
  const level = readLevel(readFieldValue(fields, 'level'));
  if (!level) return null;
  const startValue = readFieldValue(fields, 'start');
  const start = startValue && /^-?\d+$/.test(startValue)
    ? Math.max(1, Number.parseInt(startValue, 10))
    : 1;
  return {
    id: readFieldValue(fields, 'id', 'series') ?? 'default',
    level,
    format: (readFieldValue(fields, 'format') ?? 'decimal').toLowerCase(),
    text: readFieldValue(fields, 'text'),
    start,
    suffix: (readFieldValue(fields, 'suffix') ?? '').toLowerCase() || null,
  };
}

export function collectDocxGlobals(doc: ProseMirrorNode): DocxGlobalDefinitions {
  const font = new Map<string, string>();
  const paragraph = new Map<string, string>();
  const variables = new Map<string, ParsedDocxDirective[]>();
  const functions = new Map<string, DocxFunctionDefinition>();
  const headingNumbering: HeadingNumberingRule[] = [];
  const keyParts: string[] = [];
  doc.forEach((node) => {
    if (node.type.name !== 'docx_meta') return;
    const lines = Array.isArray(node.attrs.rawLines) ? node.attrs.rawLines : [];
    for (const line of lines) {
      const directive = parseLineCached(String(line));
      if (!directive) continue;
      if (directive.canonicalKeyword === 'global') {
        // `global.font` / `global.paragraph` 是文档级默认值，字段语义由目标决定。
        for (const group of directive.groups) {
          if (directive.globalTarget === 'paragraph' || group.canonicalKeyword === 'paragraph') {
            applyParagraphFields(group.fields, paragraph);
          } else if (directive.globalTarget === 'font' || group.canonicalKeyword === 'font') {
            applyFontFields(group.fields, font);
          }
        }
        if (directive.globalTarget === 'heading') {
          for (const decorator of directive.inlineDecorators) {
            const rule = headingNumberingRule(decorator);
            if (rule) headingNumbering.push(rule);
          }
        }
        keyParts.push(line);
      } else if (directive.canonicalKeyword === 'var') {
        const definition = parseVariableDefinition(directive);
        if (definition) {
          variables.set(definition.name, definition.directives);
          keyParts.push(line);
        }
      } else if (directive.canonicalKeyword === 'fun') {
        const definition = parseFunctionDefinition(directive);
        if (definition) {
          functions.set(definition.name, {
            params: definition.params,
            body: definition.body,
          });
          keyParts.push(line);
        }
      }
    }
  });
  return {
    font,
    paragraph,
    variables,
    functions,
    useCache: new Map(),
    headingNumbering,
    // 只留指纹：每个块的缓存键都要拼上它，直接拼全部定义原文会让每次重建多复制几 MB。
    key: fingerprintParts(keyParts),
  };
}

/**
 * 64 位（两路 32 位 FNV-1a）内容指纹。定义很少变化，重建时同一份定义得到同一个键，
 * 样式缓存仍可跨重建命中；碰撞概率远低于误用一位数哈希的风险。
 */
function fingerprintParts(parts: readonly string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      const code = part.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x85ebca6b);
    }
    h1 = Math.imul(h1 ^ 0x0a, 0x01000193);
    h2 = Math.imul(h2 ^ 0x0a, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${parts.length}`;
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

function fieldValue(field: DocxField): string {
  const value = field.value.trim();
  return value || 'true';
}

/**
 * `宋体 10.5pt` / `Times New Roman 12pt` / `宋体 小四` → family + size。
 *
 * 官方语法允许中文字号名（小四、五号……），也允许只写字体族。
 */
function parseFamilySize(value: string): { family: string; size: string | null } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const cjk = /^(.*?)\s*(初号|小初|一号|小一|二号|小二|三号|小三|四号|小四|五号|小五|六号|小六)$/.exec(
    trimmed,
  );
  if (cjk) {
    return { family: cjk[1]!.trim(), size: CJK_SIZES[cjk[2]!]! };
  }
  const sized = /^(.*?)\s*(-?\d+(?:\.\d+)?(?:pt|px|em|rem|cm|mm|in|%))$/i.exec(trimmed);
  if (sized) {
    return { family: sized[1]!.trim(), size: sized[2]! };
  }
  return { family: trimmed, size: null };
}

function applyFontMix(value: string, style: Map<string, string>): void {
  const parsed = parseFamilySize(value);
  if (!parsed) return;
  if (parsed.family) style.set('font-family', quoteFamilies(parsed.family));
  if (parsed.size) style.set('font-size', parsed.size);
}

function quoteFamilies(value: string): string {
  return value
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((family) => (/[\s]/.test(family) && !/^['"].*['"]$/.test(family) ? `"${family}"` : family))
    .join(', ');
}

const CJK_SIZES: Record<string, string> = {
  初号: '42pt',
  小初: '36pt',
  一号: '26pt',
  小一: '24pt',
  二号: '22pt',
  小二: '18pt',
  三号: '16pt',
  小三: '15pt',
  四号: '14pt',
  小四: '12pt',
  五号: '10.5pt',
  小五: '9pt',
  六号: '7.5pt',
  小六: '6.5pt',
};

function cssLength(value: string, fallbackUnit = 'pt'): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const cjk = CJK_SIZES[trimmed];
  if (cjk) return cjk;
  if (/^-?\d+(?:\.\d+)?(?:pt|px|em|rem|cm|mm|in|%)$/i.test(trimmed)) return trimmed;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}${fallbackUnit}`;
  return trimmed;
}

function applyFontFields(fields: DocxField[], style: Map<string, string>): void {
  for (const field of fields) {
    const name = normalizeFieldName(field.rawName);
    const value = fieldValue(field);
    const lower = value.toLowerCase();
    switch (name) {
      case 'mix':
      case 'name':
      case 'family':
      case 'font':
      case 'font.name':
        applyFontMix(value, style);
        break;
      case 'zh':
      case 'cn':
      case 'eastasia': {
        // `zh: 宋体 小四` 同时包含字体族与中文字号，不能整体当字体名。
        const parsed = parseFamilySize(value);
        if (parsed?.family) style.set('font-family', quoteFamilies(parsed.family));
        if (parsed?.size) style.set('font-size', parsed.size);
        break;
      }
      case 'en':
      case 'ascii':
      case 'latin':
      case 'hansi': {
        const parsed = parseFamilySize(value);
        if (parsed?.family) {
          const existing = style.get('font-family');
          style.set(
            'font-family',
            existing ? `${quoteFamilies(parsed.family)}, ${existing}` : quoteFamilies(parsed.family),
          );
        }
        if (parsed?.size) style.set('font-size', parsed.size);
        break;
      }
      case 'size':
      case 'font.size':
      case 'fontsize':
        style.set('font-size', cssLength(value));
        break;
      case 'style':
        applyFontStyleTokens(lower, style);
        break;
      case 'bold':
      case 'b':
        if (truthy(lower)) style.set('font-weight', '700');
        break;
      case 'italic':
      case 'i':
        if (truthy(lower)) style.set('font-style', 'italic');
        break;
      case 'underline':
      case 'u':
        if (truthy(lower)) style.set('text-decoration-line', 'underline');
        break;
      case 'strike':
      case 'strikethrough':
      case 'strikeout':
        if (truthy(lower)) style.set('text-decoration-line', 'line-through');
        break;
      case 'color':
      case 'font.color':
        if (value) style.set('color', value);
        break;
      case 'highlight':
      case 'shading':
      case 'background':
      case 'bg':
      case 'font.highlight':
        if (value) style.set('background-color', value);
        break;
      case 'superscript':
      case 'vertalign':
        if (lower === 'superscript' || truthy(lower)) {
          style.set('vertical-align', 'super');
          style.set('font-size', 'smaller');
        } else if (lower === 'subscript') {
          style.set('vertical-align', 'sub');
          style.set('font-size', 'smaller');
        }
        break;
      case 'subscript':
        if (truthy(lower)) {
          style.set('vertical-align', 'sub');
          style.set('font-size', 'smaller');
        }
        break;
      case 'spacing':
      case 'letter.spacing':
      case 'char.spacing':
        style.set('letter-spacing', cssLength(value));
        break;
      default:
        break;
    }
  }
}

function applyFontStyleTokens(lower: string, style: Map<string, string>): void {
  if (!lower) return;
  if (lower === 'norm' || lower === 'normal' || lower === 'regular') {
    // 显式 norm 必须能覆盖外层的上标/下标与格式。
    style.set('font-weight', 'normal');
    style.set('font-style', 'normal');
    style.set('text-decoration-line', 'none');
    style.set('vertical-align', 'baseline');
    return;
  }
  if (lower.includes('bold')) style.set('font-weight', '700');
  if (lower.includes('italic')) style.set('font-style', 'italic');
  if (lower.includes('underline')) style.set('text-decoration-line', 'underline');
  if (lower.includes('strike')) style.set('text-decoration-line', 'line-through');
  if (lower.includes('superscript')) {
    style.set('vertical-align', 'super');
    style.set('font-size', 'smaller');
  } else if (lower.includes('subscript')) {
    style.set('vertical-align', 'sub');
    style.set('font-size', 'smaller');
  }
}

function truthy(value: string): boolean {
  return value === 'true' || value === '1' || value === 'yes' || value === 'on' || value === '是';
}

function applyParagraphFields(fields: DocxField[], style: Map<string, string>): void {
  // `special: hanging; special.by: 2char` 是参考文献的悬挂缩进，两个字段必须
  // 一起解释；单独按字段顺序处理会丢失 `special.by`。
  const byName = new Map<string, string>();
  for (const field of fields) {
    byName.set(normalizeFieldName(field.canonicalName || field.rawName), fieldValue(field));
  }
  const special = byName.get('special');
  if (special) {
    const amount = indentLength(byName.get('special.by') ?? byName.get('specialby') ?? '2char');
    if (/hang|悬挂/i.test(special)) {
      style.set('padding-left', amount);
      style.set('text-indent', `-${amount}`);
    } else if (/first|首行/i.test(special)) {
      style.set('text-indent', amount);
    }
  }
  for (const field of fields) {
    const name = normalizeFieldName(field.canonicalName || field.rawName);
    const value = fieldValue(field);
    switch (name) {
      case 'align':
      case 'align.horizontal':
      case 'paragraph.align': {
        const align = value.toLowerCase();
        style.set('text-align', align === 'both' || align === 'distribute' ? 'justify' : align);
        break;
      }
      case 'indent.firstline':
      case 'firstline':
      case 'firstlineindent':
      case 'indentfirstline':
        style.set('text-indent', indentLength(value));
        break;
      case 'indent.left':
      case 'leftindent':
      case 'indentleft':
        style.set('margin-left', cssLength(value));
        break;
      case 'indent.right':
      case 'rightindent':
      case 'indentright':
        style.set('margin-right', cssLength(value));
        break;
      case 'space.before':
      case 'spacebefore':
      case 'before':
        style.set('margin-top', cssLength(value));
        break;
      case 'space.after':
      case 'spaceafter':
      case 'after':
        style.set('margin-bottom', cssLength(value));
        break;
      case 'line.spacing':
      case 'linespacing':
        style.set('line-height', lineHeight(value));
        break;
      case 'tabs': {
        // `tabs: right 18.8cm`（可逗号分隔多项）→ `[[TAB]]` 跳到右边界。
        const right = /(?:^|,)\s*right\s+([^\s,]+)/i.exec(value);
        if (right) style.set('--docx-tab-right', cssLength(right[1]!));
        break;
      }
      default:
        break;
    }
  }
}

function indentLength(value: string): string {
  const charMatch = /^(-?\d+(?:\.\d+)?)\s*(?:char|字符|字)$/i.exec(value.trim());
  if (charMatch) return `${charMatch[1]}em`;
  return cssLength(value);
}

function lineHeight(value: string): string {
  const trimmed = value.trim().replace(/(?:倍|lines?)$/i, '');
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  return cssLength(trimmed);
}

interface ImageSettings {
  width: string | null;
  height: string | null;
  align: string | null;
  fit: string | null;
  wrap: string | null;
}

/** `@caption.numbering` / `@formula.numbering` 的展示参数。 */
interface NumberingRuleSettings {
  series: string | null;
  label: string | null;
  format: string | null;
  chapterLevel: number | null;
  separator: string | null;
  restart: string | null;
}

interface CaptionSettings {
  type: string | null;
  id: string | null;
  numbering: NumberingRuleSettings | null;
}

interface FormulaSettings {
  number: string | null;
  id: string | null;
  numbering: NumberingRuleSettings | null;
}

interface ReferenceSettings {
  id: string | null;
}

interface BreakSettings {
  type: string | null;
  position: string | null;
}

interface TableContinuation {
  startRows: number[];
  captionId: string | null;
  title: string | null;
  style: Map<string, string> | null;
}

interface SelectorRange {
  from: number | null;
  to: number | null;
}

interface TableParagraphRule {
  row: SelectorRange;
  column: SelectorRange;
  paragraph: SelectorRange;
  style: Map<string, string>;
}

interface TableCellRule {
  row: SelectorRange;
  column: SelectorRange;
  style: Map<string, string>;
}

interface TableSettings {
  borderVisible: string[] | null;
  borderWidth: string | null;
  borderStyle: string | null;
  borderColor: string | null;
  align: string | null;
  colWidths: string[] | null;
  rowHeight: string | null;
  rowVAlign: string | null;
  rowOddBg: string | null;
  rowEvenBg: string | null;
  rowOddColor: string | null;
  rowEvenColor: string | null;
  /** 整表单元格内边距；`@table.cell | padding` 可逐格覆盖。 */
  padding: string | null;
  header: Map<string, string> | null;
  body: Map<string, string> | null;
  /**
   * `@table.cell` 规则；坐标是包含表头行的 0-based 逻辑坐标，支持 `:` 切片。
   * 按出现顺序叠加，后写的规则覆盖先写的。
   */
  cells: TableCellRule[];
  /** `@table.paragraph`：单元格内 `[[NEW | & paragraph]]` 段落的样式。 */
  paragraphs: TableParagraphRule[];
  /** `@table.continuation`：续表拆分点（正文行，1 基）。 */
  continuation: TableContinuation | null;
}

interface ResolvedBlockPresentation {
  style: Map<string, string>;
  headingLevel: number | null;
  /** 当前块局部 `@heading.numbering`；优先于文档级规则。 */
  headingNumbering: HeadingNumberingRule[] | null;
  listFormat: string | null;
  listStart: number | null;
  /** 列表嵌套级别（`nest` / `@list.numbering level`）。 */
  listLevel: number | null;
  /** 自定义编号文本模板（`text: %1.`），仅用于面板与悬停提示。 */
  listMarker: string | null;
  /** 编号格式是否来自 `@list.numbering`；是则覆盖 `list | ordered/unordered`。 */
  listNumbered: boolean;
  image: ImageSettings | null;
  caption: CaptionSettings | null;
  formula: FormulaSettings | null;
  reference: ReferenceSettings | null;
  break: BreakSettings | null;
  table: TableSettings | null;
}

interface DocxGroupLike {
  canonicalKeyword?: string;
  keyword?: string;
  body?: string;
  fields: DocxField[];
}

function groupKeyword(group: DocxGroupLike): string {
  return String(group.canonicalKeyword ?? group.keyword ?? '').toLowerCase();
}

function fieldName(field: DocxField): string {
  return normalizeFieldName(field.canonicalName || field.rawName);
}

function readField(fields: DocxField[], ...names: string[]): DocxField | null {
  for (const field of fields) {
    if (names.includes(fieldName(field))) return field;
  }
  return null;
}

function readFieldValue(fields: DocxField[], ...names: string[]): string | null {
  const field = readField(fields, ...names);
  const value = field?.value.trim();
  return value ? value : null;
}

function readNumberingRule(fields: DocxField[], withLabel: boolean): NumberingRuleSettings {
  const levelText = readFieldValue(fields, 'chapter.level');
  const parsedLevel = levelText ? Number.parseInt(levelText, 10) : Number.NaN;
  const restart = readFieldValue(fields, 'restart');
  return {
    series: readFieldValue(fields, 'series'),
    label: withLabel ? readFieldValue(fields, 'label') : null,
    format: readFieldValue(fields, 'format'),
    chapterLevel:
      Number.isInteger(parsedLevel) && parsedLevel >= 1 && parsedLevel <= 9
        ? parsedLevel
        : null,
    separator: readFieldValue(fields, 'separator'),
    restart: restart ? restart.toLowerCase() : null,
  };
}

function mergeStyle(target: Map<string, string>, source: Map<string, string>): Map<string, string> {
  for (const [name, value] of source) target.set(name, value);
  return target;
}

/**
 * 表格单元格/表头作用域的字段（背景、边框、字体、对齐、垂直对齐、行高）。
 *
 * 三线表常写成 `@table.header | border.visible: bottom; border.thickness: 0.75pt`，
 * 表头单元格的底边线必须落在单元格装饰上。
 */
function applyCellFields(fields: DocxField[], style: Map<string, string>): void {
  const borderVisible = readFieldValue(fields, 'border.visible');
  if (borderVisible) {
    const width = cssLength(readFieldValue(fields, 'border.thickness', 'border.width') ?? '0.5pt');
    const lineStyle = borderLineStyle(readFieldValue(fields, 'border.style') ?? 'single');
    const color = readFieldValue(fields, 'border.color') ?? '#000000';
    const declaration = `${width} ${lineStyle} ${color}`;
    const tokens = borderVisible
      .split(/[\s,]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    const sides =
      tokens.includes('all') || tokens.includes('box')
        ? ['top', 'right', 'bottom', 'left']
        : tokens.filter((token) => ['top', 'right', 'bottom', 'left'].includes(token));
    for (const side of sides) style.set(`border-${side}`, declaration);
  }
  for (const field of fields) {
    const name = fieldName(field);
    const value = field.value.trim();
    if (!value) continue;
    switch (name) {
      case 'bg':
      case 'background':
      case 'background.color':
      case 'shading':
        style.set('background-color', value);
        break;
      case 'color':
      case 'font.color':
        style.set('color', value);
        break;
      case 'font':
      case 'mix': {
        // `@table.header | font: mix 宋体 五号` 是字段形式，与 `& font | mix: ...` 等价。
        const cleaned = value.replace(/^mix\s+/i, '');
        applyFontMix(cleaned, style);
        break;
      }
      case 'style':
        applyFontStyleTokens(value.toLowerCase(), style);
        break;
      case 'align':
      case 'align.horizontal':
      case 'paragraph.align':
        style.set('text-align', value.toLowerCase() === 'both' ? 'justify' : value.toLowerCase());
        break;
      case 'row.valign':
      case 'valign':
      case 'vertical.align':
        style.set('vertical-align', verticalAlign(value));
        break;
      case 'row.height':
        if (!/^(fit|auto)$/i.test(value)) style.set('height', cssLength(value));
        break;
      case 'padding':
        // 与 Word 一致：0 / 1–4 个长度值，CSS 语法相同。
        style.set('padding', value);
        break;
      case 'bold':
      case 'b':
        if (truthy(value.toLowerCase())) style.set('font-weight', '700');
        break;
      default:
        break;
    }
  }
}

function borderLineStyle(value: string): string {
  const lower = value.trim().toLowerCase();
  if (lower === 'single') return 'solid';
  if (lower === 'double') return 'double';
  if (lower === 'dash' || lower === 'dashed') return 'dashed';
  if (lower === 'dot' || lower === 'dotted') return 'dotted';
  return lower || 'solid';
}

function verticalAlign(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'center' || lower === 'middle') return 'middle';
  if (lower === 'bottom') return 'bottom';
  return 'top';
}

function createTableSettings(): TableSettings {
  return {
    borderVisible: null,
    borderWidth: null,
    borderStyle: null,
    borderColor: null,
    align: null,
    colWidths: null,
    rowHeight: null,
    rowVAlign: null,
    rowOddBg: null,
    rowEvenBg: null,
    rowOddColor: null,
    rowEvenColor: null,
    padding: null,
    header: null,
    body: null,
    cells: [],
    paragraphs: [],
    continuation: null,
  };
}

function applyTableFields(fields: DocxField[], table: TableSettings): void {
  for (const field of fields) {
    const name = fieldName(field);
    const value = field.value.trim();
    if (!value) continue;
    switch (name) {
      case 'border.visible': {
        const tokens = value
          .split(/[\s,]+/)
          .map((token) => token.trim().toLowerCase())
          .filter(Boolean);
        if (tokens.length) table.borderVisible = tokens;
        break;
      }
      case 'border.thickness':
      case 'border.width':
        table.borderWidth = cssLength(value);
        break;
      case 'border.style':
        table.borderStyle = borderLineStyle(value);
        break;
      case 'border.color':
        table.borderColor = value;
        break;
      case 'layout.align':
      case 'align':
        table.align = value.toLowerCase();
        break;
      case 'col.width':
      case 'column.width':
        table.colWidths = value
          .split(/[\s,]+/)
          .map((token) => token.trim())
          .filter(Boolean);
        break;
      case 'row.height': {
        // `fit 0.5cm 0.5cm` = 按内容撑开，但每行不低于 0.5cm；`exact` 由
        // CSS height 直接保留声明高度。
        const fit = /^(?:fit|auto)\b/i.test(value);
        const length = /(-?\d+(?:\.\d+)?(?:pt|px|em|rem|cm|mm|in|%))/i.exec(value)?.[1];
        if (fit) {
          if (length) table.rowHeight = cssLength(length);
        } else if (!/^(fit|auto)$/i.test(value)) {
          table.rowHeight = cssLength(value);
        }
        break;
      }
      case 'padding':
        table.padding = value;
        break;
      case 'row.valign':
        table.rowVAlign = verticalAlign(value);
        break;
      case 'row.oddbg':
        table.rowOddBg = value;
        break;
      case 'row.evenbg':
        table.rowEvenBg = value;
        break;
      case 'row.oddcolor':
        table.rowOddColor = value;
        break;
      case 'row.evencolor':
        table.rowEvenColor = value;
        break;
      default:
        break;
    }
  }
}

function applyImageFields(fields: DocxField[], image: ImageSettings): void {
  for (const field of fields) {
    const name = fieldName(field);
    const value = field.value.trim();
    if (!value) continue;
    switch (name) {
      case 'size.width':
      case 'width':
        image.width = value;
        break;
      case 'size.height':
      case 'height':
        image.height = value;
        break;
      case 'layout.align':
      case 'align':
        image.align = value.toLowerCase();
        break;
      case 'layout.fit':
      case 'fit':
        image.fit = value.toLowerCase();
        break;
      case 'layout.wrap':
      case 'wrap':
        image.wrap = value.toLowerCase();
        break;
      default:
        break;
    }
  }
}

function isImageGroup(group: DocxGroupLike): boolean {
  const keyword = groupKeyword(group);
  return keyword === 'image' || keyword.startsWith('@image.');
}

/**
 * 单元格与行内标记里的 `& image | size.width: 0.78cm; layout.align: left`。
 *
 * 图片尺寸不能写进 `ResolvedBlockPresentation.image`（那是整块的图片指令），
 * 所以以 CSS 自定义属性落在单元格/行内范围上，由样式表里的后代选择器读取。
 */
function applyImageGroupToStyle(group: DocxGroupLike, style: Map<string, string>): void {
  const keyword = groupKeyword(group);
  if (keyword.startsWith('@image.')) {
    const wrap = keyword.slice('@image.'.length);
    if (['inline', 'square', 'tight', 'through', 'topandbottom'].includes(wrap)) {
      style.set('--docx-image-wrap', wrap);
    }
  }
  for (const field of group.fields) {
    const name = fieldName(field);
    const value = field.value.trim();
    if (!value) continue;
    switch (name) {
      case 'size.width':
      case 'width':
        style.set('--docx-image-width', cssLength(value));
        break;
      case 'size.height':
      case 'height':
        style.set('--docx-image-height', cssLength(value));
        break;
      case 'layout.align':
      case 'align':
        // 单元格里的图片对齐等价于文字对齐。
        style.set('text-align', value.toLowerCase() === 'both' ? 'justify' : value.toLowerCase());
        break;
      default:
        break;
    }
  }
}

/** 解析 `position: (1, 0)`；负索引按包含表头行的逻辑坐标回绕。 */
export interface TableCellPosition {
  row: SelectorRange;
  column: SelectorRange;
}

/**
 * 解析 `@table.cell | position: (row, col)`，支持 Python 风格切片
 * （`(: , 0)`、`(1:, :)`、`(-1, :)`）。
 */
export function parseTableCellPosition(value: string): TableCellPosition | null {
  const match = /^\(\s*([^,]+?)\s*,\s*([^,]+?)\s*\)$/.exec(value.trim());
  if (!match) return null;
  const row = parseSelectorRange(match[1]!);
  const column = parseSelectorRange(match[2]!);
  if (!row || !column) return null;
  return { row, column };
}

export interface TableParagraphPosition {
  row: SelectorRange;
  column: SelectorRange;
  paragraph: SelectorRange;
}

/**
 * 选择器项：`3` 是单索引，`1:` / `:2` / `1:3` 是切片。
 * 内部区间用闭区间表示，切片右端按 Python 语义换算成 `to - 1`。
 */
function parseSelectorRange(value: string): SelectorRange | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === ':') return { from: null, to: null };
  const slice = /^(-?\d+)?\s*:\s*(-?\d+)?$/.exec(trimmed);
  if (slice) {
    const from = slice[1] === undefined ? null : Number.parseInt(slice[1], 10);
    if (slice[2] === undefined) return { from, to: null };
    const end = Number.parseInt(slice[2], 10);
    // Python `[:0]` 为空；用 from > to 表示“永不匹配”。
    if (end === 0) return { from: 1, to: 0 };
    return { from, to: end - 1 };
  }
  if (!/^-?\d+$/.test(trimmed)) return null;
  const exact = Number.parseInt(trimmed, 10);
  return { from: exact, to: exact };
}

/** 解析 `@table.paragraph | position: (row, column, paragraph)`，支持 `:` 切片。 */
export function parseTableParagraphPosition(value: string): TableParagraphPosition | null {
  const match = /^\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,)]+)\s*\)$/.exec(value.trim());
  if (!match) return null;
  const row = parseSelectorRange(match[1]!);
  const column = parseSelectorRange(match[2]!);
  const paragraph = parseSelectorRange(match[3]!);
  if (!row || !column || !paragraph) return null;
  return { row, column, paragraph };
}

function selectorMatches(range: SelectorRange, value: number, total: number): boolean {
  let from = range.from;
  let to = range.to;
  if (from != null && from < 0) from = total + from;
  if (to != null && to < 0) to = total + to;
  if (from != null && to != null && from > to) return false;
  if (from != null && value < from) return false;
  if (to != null && value > to) return false;
  return true;
}

/** 官方编号格式 → CSS `list-style-type`。 */
function listStyleType(value: string): string {
  const token = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  switch (token) {
    case 'decimal':
    case 'arabic':
    case 'number':
      return 'decimal';
    case 'upperroman':
      return 'upper-roman';
    case 'lowerroman':
      return 'lower-roman';
    case 'upperletter':
    case 'upperalpha':
      return 'upper-alpha';
    case 'lowerletter':
    case 'loweralpha':
      return 'lower-alpha';
    case 'bullet':
      return 'disc';
    case 'circle':
      return 'circle';
    case 'square':
      return 'square';
    case 'chinesecounting':
    case 'chinese':
      return 'cjk-ideographic';
    case 'none':
      return 'none';
    default:
      return token;
  }
}

/** `@list.numbering` / `& numbering` 的编号、缩进、颜色与对齐。 */
function applyListNumbering(
  fields: DocxField[],
  style: Map<string, string>,
  resolved: ResolvedBlockPresentation,
): void {
  const format = readFieldValue(fields, 'format');
  if (format) {
    resolved.listFormat = listStyleType(format);
    resolved.listNumbered = true;
  }
  const start = readFieldValue(fields, 'start');
  if (start && /^-?\d+$/.test(start)) resolved.listStart = Number.parseInt(start, 10);
  const indentLeft = readFieldValue(fields, 'indent.left');
  if (indentLeft) style.set('padding-left', cssLength(indentLeft));
  const indentHanging = readFieldValue(fields, 'indent.hanging');
  if (indentHanging) style.set('text-indent', `-${cssLength(indentHanging)}`);
  const color = readFieldValue(fields, 'color');
  if (color) style.set('color', color);
  const alignment = readFieldValue(fields, 'alignment', 'align');
  if (alignment) {
    style.set('text-align', alignment.toLowerCase() === 'both' ? 'justify' : alignment.toLowerCase());
  }
  const level = readFieldValue(fields, 'level');
  if (level && /^\d+$/.test(level)) resolved.listLevel = Number.parseInt(level, 10);
  const marker = readFieldValue(fields, 'text');
  if (marker) resolved.listMarker = marker;
}

/** 把一个 `&` 分组写入样式表；块级与行内标记共用。 */
function applyGroupToStyle(
  group: DocxGroupLike,
  style: Map<string, string>,
  resolved: ResolvedBlockPresentation | null,
): void {
  const keyword = groupKeyword(group);
  if (keyword === 'font') {
    applyFontFields(group.fields, style);
  } else if (keyword === 'paragraph') {
    applyParagraphFields(group.fields, style);
  } else if (keyword === 'numbering' || keyword === '@list.numbering') {
    if (resolved) applyListNumbering(group.fields, style, resolved);
  } else if (keyword === 'heading' && resolved) {
    const levelValue = readFieldValue(group.fields, 'level');
    if (levelValue) {
      const level = Number.parseInt(levelValue.replace(/^h/i, ''), 10);
      if (level >= 1 && level <= 9) resolved.headingLevel = level;
    }
  } else if (keyword === 'list' && resolved) {
    const ordered = readFieldValue(group.fields, 'ordered');
    const unordered = readFieldValue(group.fields, 'unordered');
    // `@list.numbering` 的 format 是更明确的编号规则，优先于 list 的预设。
    if ((unordered || ordered) && !resolved.listNumbered) {
      resolved.listFormat = listStyleType(unordered || ordered || '');
    }
    const start = readFieldValue(group.fields, 'start', 'start.at');
    if (start && /^-?\d+$/.test(start)) resolved.listStart = Number.parseInt(start, 10);
    const nest = readFieldValue(group.fields, 'nest');
    if (nest && /^\d+$/.test(nest)) resolved.listLevel = Number.parseInt(nest, 10);
  }
}

function applyUseReference(
  rawName: string,
  style: Map<string, string>,
  globals: DocxGlobalDefinitions,
  resolved: ResolvedBlockPresentation | null,
  depth: number,
): void {
  if (depth > 4) return;
  const definition = resolveUseDefinition(rawName, globals);
  if (!definition) return;
  for (const inner of definition) {
    applyDirectiveToStyle(inner, style, globals, resolved, depth + 1);
  }
}

/** 依次应用 `&` 分组；`use` 分组先展开定义。 */
function applyGroupsToStyle(
  groups: DocxGroupLike[],
  style: Map<string, string>,
  globals: DocxGlobalDefinitions,
  resolved: ResolvedBlockPresentation | null,
  depth: number,
): void {
  for (const group of groups) {
    if (groupKeyword(group) === 'use') {
      applyUseReference(String(group.body ?? ''), style, globals, resolved, depth + 1);
      continue;
    }
    applyGroupToStyle(group, style, resolved);
  }
}

function applyDirectiveToStyle(
  directive: ParsedDocxDirective,
  style: Map<string, string>,
  globals: DocxGlobalDefinitions,
  resolved: ResolvedBlockPresentation | null,
  depth: number,
): void {
  if (depth > 4) return;
  if (directive.canonicalKeyword === 'use') {
    applyUseReference(directive.body, style, globals, resolved, depth);
    // `use base & paragraph | keepNext: true`：右侧覆盖指令继续生效。
    applyGroupsToStyle(directive.groups.slice(1), style, globals, resolved, depth + 1);
    for (const inner of directive.inlineDecorators) {
      applyDirectiveToStyle(inner, style, globals, resolved, depth + 1);
    }
    return;
  }

  const mainFields = directive.groups[0]?.fields ?? [];
  /** `@table.*` 的 `& font`/`& paragraph` 只作用于该作用域，不能泄漏到整张表。 */
  let groupsConsumed = false;
  if (resolved) {
    const keyword = directive.canonicalKeyword;
    if (keyword === 'table') {
      resolved.table ??= createTableSettings();
      applyTableFields(mainFields, resolved.table);
    } else if (keyword === 'image') {
      resolved.image ??= { width: null, height: null, align: null, fit: null, wrap: null };
      applyImageFields(mainFields, resolved.image);
    } else if (keyword.startsWith('@image.')) {
      resolved.image ??= { width: null, height: null, align: null, fit: null, wrap: null };
      const wrap = keyword.slice('@image.'.length);
      if (['inline', 'square', 'tight', 'through', 'topandbottom'].includes(wrap)) {
        resolved.image.wrap = wrap;
      }
      applyImageFields(mainFields, resolved.image);
    } else if (keyword === 'caption') {
      resolved.caption ??= { type: null, id: null, numbering: null };
      const type = readFieldValue(mainFields, 'type');
      if (type) resolved.caption.type = type.toLowerCase();
      const id = readFieldValue(mainFields, 'id');
      if (id) resolved.caption.id = id;
    } else if (keyword === '@caption.numbering') {
      resolved.caption ??= { type: null, id: null, numbering: null };
      resolved.caption.numbering = readNumberingRule(mainFields, true);
    } else if (keyword === 'formula') {
      resolved.formula ??= { number: null, id: null, numbering: null };
      const number = readFieldValue(mainFields, 'number');
      if (number) resolved.formula.number = number;
      const id = readFieldValue(mainFields, 'id');
      if (id) resolved.formula.id = id;
    } else if (keyword === '@formula.numbering') {
      resolved.formula ??= { number: null, id: null, numbering: null };
      resolved.formula.numbering = readNumberingRule(mainFields, false);
    } else if (keyword === 'reference') {
      resolved.reference ??= { id: null };
      const id = readFieldValue(mainFields, 'id');
      if (id) resolved.reference.id = id;
    } else if (keyword === 'break') {
      resolved.break ??= { type: null, position: null };
      const type = readFieldValue(mainFields, 'type');
      if (type) resolved.break.type = type.toLowerCase();
      const position = readFieldValue(mainFields, 'position');
      if (position) resolved.break.position = position.toLowerCase();
    } else if (keyword === '@list.numbering') {
      applyListNumbering(mainFields, style, resolved);
    } else if (keyword === '@heading.numbering') {
      const rule = headingNumberingRule(directive);
      if (rule) {
        resolved.headingNumbering ??= [];
        resolved.headingNumbering.push(rule);
      }
    } else if (keyword === '@table.header' || keyword === '@table.body') {
      resolved.table ??= createTableSettings();
      const scopeStyle = new Map<string, string>();
      applyCellFields(mainFields, scopeStyle);
      for (const group of directive.groups.slice(1)) {
        if (isImageGroup(group)) {
          applyImageGroupToStyle(group, scopeStyle);
          continue;
        }
        applyGroupToStyle(group, scopeStyle, null);
      }
      if (keyword === '@table.header') {
        resolved.table.header = mergeStyle(resolved.table.header ?? new Map(), scopeStyle);
      } else {
        resolved.table.body = mergeStyle(resolved.table.body ?? new Map(), scopeStyle);
      }
      groupsConsumed = true;
    } else if (keyword === '@table.cell') {
      resolved.table ??= createTableSettings();
      const positionValue = readFieldValue(mainFields, 'position');
      const position = positionValue ? parseTableCellPosition(positionValue) : null;
      if (position) {
        const cellStyle = new Map<string, string>();
        applyCellFields(mainFields, cellStyle);
        for (const group of directive.groups.slice(1)) {
          if (isImageGroup(group)) {
            applyImageGroupToStyle(group, cellStyle);
            continue;
          }
          applyGroupToStyle(group, cellStyle, null);
        }
        // 负索引与切片在布局阶段按实际表格尺寸求值；这里保留选择器原样。
        resolved.table.cells.push({ ...position, style: cellStyle });
      }
      groupsConsumed = true;
    } else if (keyword === '@table.paragraph') {
      resolved.table ??= createTableSettings();
      const positionValue = readFieldValue(mainFields, 'position');
      const position = positionValue ? parseTableParagraphPosition(positionValue) : null;
      if (position) {
        const paragraphStyle = new Map<string, string>();
        for (const group of directive.groups.slice(1)) {
          applyGroupToStyle(group, paragraphStyle, null);
        }
        resolved.table.paragraphs.push({ ...position, style: paragraphStyle });
      }
      groupsConsumed = true;
    } else if (keyword === '@table.continuation') {
      resolved.table ??= createTableSettings();
      const startRows = readFieldValue(mainFields, 'startrows', 'start.rows')
        ?.split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((row) => Number.isInteger(row) && row > 0) ?? [];
      const continuationStyle = new Map<string, string>();
      for (const group of directive.groups.slice(1)) {
        applyGroupToStyle(group, continuationStyle, null);
      }
      resolved.table.continuation = {
        startRows,
        captionId: readFieldValue(mainFields, 'caption.id'),
        title: readFieldValue(mainFields, 'title'),
        style: continuationStyle.size ? continuationStyle : null,
      };
      groupsConsumed = true;
    }
  }

  if (!groupsConsumed) {
    applyGroupsToStyle(directive.groups, style, globals, resolved, depth);
  }
  for (const inner of directive.inlineDecorators) {
    applyDirectiveToStyle(inner, style, globals, resolved, depth + 1);
  }
}

/** 行内 `[[NEW | & use bullet & font | ...]]` 的样式。 */
function resolveMarkerGroupsStyle(
  groups: DocxGroupLike[],
  globals: DocxGlobalDefinitions,
  depth = 0,
): Map<string, string> {
  const style = new Map<string, string>();
  for (const group of groups) {
    const keyword = groupKeyword(group);
    if (keyword === 'use') {
      if (depth > 4) continue;
      const definition = resolveUseDefinition(String(group.body ?? ''), globals);
      if (definition) {
        for (const directive of definition) {
          applyDirectiveToStyle(directive, style, globals, null, depth + 1);
        }
      }
      continue;
    }
    if (isImageGroup(group)) {
      applyImageGroupToStyle(group, style);
      continue;
    }
    applyGroupToStyle(group, style, null);
  }
  return style;
}

const PARAGRAPH_SEMANTICS = new Set(['paragraph']);
const PARAGRAPH_OR_LIST_SEMANTICS = new Set(['paragraph', 'list']);

/** 分组是否（经 `use` 展开后）声明了段落/列表语义。 */
function groupsHaveSemantics(
  groups: DocxGroupLike[],
  globals: DocxGlobalDefinitions,
  keywords: ReadonlySet<string>,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  for (const group of groups) {
    const keyword = groupKeyword(group);
    if (keywords.has(keyword)) return true;
    if (keyword !== 'use') continue;
    const definition = resolveUseDefinition(String(group.body ?? ''), globals);
    if (definition?.some((directive) => directiveHasSemantics(directive, globals, keywords, depth + 1))) {
      return true;
    }
  }
  return false;
}

function directiveHasSemantics(
  directive: ParsedDocxDirective,
  globals: DocxGlobalDefinitions,
  keywords: ReadonlySet<string>,
  depth: number,
): boolean {
  if (depth > 4) return false;
  if (groupsHaveSemantics(directive.groups, globals, keywords, depth)) return true;
  return directive.inlineDecorators.some((inner) =>
    directiveHasSemantics(inner, globals, keywords, depth + 1),
  );
}

function createBlockPresentation(globals: DocxGlobalDefinitions): ResolvedBlockPresentation {
  const resolved: ResolvedBlockPresentation = {
    style: new Map(globals.font),
    headingLevel: null,
    headingNumbering: null,
    listFormat: null,
    listStart: null,
    listLevel: null,
    listMarker: null,
    listNumbered: false,
    image: null,
    caption: null,
    formula: null,
    reference: null,
    break: null,
    table: null,
  };
  for (const [name, value] of globals.paragraph) resolved.style.set(name, value);
  return resolved;
}

function resolvePrefix(
  lines: string[],
  globals: DocxGlobalDefinitions,
  cacheKey: string,
): ResolvedBlockPresentation {
  const cached = styleCache.get(cacheKey);
  if (cached) return cached;

  const resolved = createBlockPresentation(globals);
  for (const line of lines) {
    const directive = parseLineCached(line);
    if (directive) applyDirectiveToStyle(directive, resolved.style, globals, resolved, 0);
  }

  styleCache.set(cacheKey, resolved);
  // 逐项淘汰最早的缓存，避免大文档（上千个不同样式块）反复整体失效。
  while (styleCache.size > STYLE_CACHE_LIMIT) {
    const oldest = styleCache.keys().next().value;
    if (oldest === undefined) break;
    styleCache.delete(oldest);
  }
  return resolved;
}

function romanNumber(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let remaining = value;
  let text = '';
  for (const [amount, numeral] of table) {
    while (remaining >= amount) {
      text += numeral;
      remaining -= amount;
    }
  }
  return text;
}

function letterNumber(value: number): string {
  if (value <= 0) return String(value);
  let remaining = value;
  let text = '';
  while (remaining > 0) {
    remaining -= 1;
    text = String.fromCharCode(65 + (remaining % 26)) + text;
    remaining = Math.floor(remaining / 26);
  }
  return text;
}

function chineseNumber(value: number): string {
  if (value <= 0 || value > 99) return String(value);
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value]!;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? '' : digits[tens]}十${ones ? digits[ones] : ''}`;
}

function formatCounter(value: number, format: string): string {
  switch (format.toLowerCase()) {
    case 'upperletter':
    case 'upperalpha':
      return letterNumber(value);
    case 'lowerletter':
    case 'loweralpha':
      return letterNumber(value).toLowerCase();
    case 'upperroman':
      return romanNumber(value);
    case 'lowerroman':
      return romanNumber(value).toLowerCase();
    case 'chinesecounting':
    case 'chinese':
      return chineseNumber(value);
    case 'none':
      return '';
    default:
      return String(value);
  }
}

function findHeadingNumberingRule(
  level: number,
  presentation: ResolvedBlockPresentation,
  globals: DocxGlobalDefinitions,
): HeadingNumberingRule | null {
  if (level < 1 || level > 9) return null;
  const localRules = presentation.headingNumbering ?? [];
  return (
    [...localRules].reverse().find((rule) => rule.level === level) ??
    [...globals.headingNumbering].reverse().find((rule) => rule.level === level) ??
    null
  );
}

/** 当前文档位置某一级标题的计数值；`@caption.numbering` 按章编号使用。 */
function currentHeadingCounter(
  level: number,
  presentation: ResolvedBlockPresentation,
  globals: DocxGlobalDefinitions,
  states: Map<string, number[]>,
): number | null {
  const rule = findHeadingNumberingRule(level, presentation, globals);
  if (!rule) return null;
  const value = states.get(rule.id)?.[level - 1] ?? 0;
  return value > 0 ? value : null;
}

interface SeriesCounter {
  count: number;
  chapter: number | null;
}

/**
 * `@caption.numbering` / `@formula.numbering` 的自动编号。
 *
 * `restart: chapter` 在当前章号变化时清零；章号取自标题自动编号的计数器，
 * 因此未启用 `@heading.numbering` 时只显示序号，不伪造章节号。
 */
function automaticNumber(
  numbering: NumberingRuleSettings,
  states: Map<string, SeriesCounter>,
  fallbackSeries: string,
  presentation: ResolvedBlockPresentation,
  globals: DocxGlobalDefinitions,
  headingStates: Map<string, number[]>,
): string {
  const chapter = numbering.chapterLevel
    ? currentHeadingCounter(numbering.chapterLevel, presentation, globals, headingStates)
    : null;
  const series = numbering.series ?? fallbackSeries;
  const state = states.get(series) ?? { count: 0, chapter: null };
  if (numbering.restart === 'chapter' && state.chapter !== chapter) {
    state.count = 0;
    state.chapter = chapter;
  }
  state.count += 1;
  states.set(series, state);
  const formatted = formatCounter(state.count, numbering.format ?? 'decimal');
  if (chapter == null) return formatted;
  return `${chapter}${numbering.separator ?? '.'}${formatted}`;
}

/**
 * 按文档顺序计算标题自动编号。
 *
 * `@heading.numbering` 不写入正文，只在节点装饰上生成可见前缀；计数状态按
 * `id` 系列维护，进入下一级时清零更深层计数，与 Word 的多级列表一致。
 */
function headingNumberText(
  level: number,
  presentation: ResolvedBlockPresentation,
  globals: DocxGlobalDefinitions,
  states: Map<string, number[]>,
): string | null {
  if (level < 1 || level > 9) return null;
  const rule = findHeadingNumberingRule(level, presentation, globals);
  if (!rule) return null;
  const localRules = presentation.headingNumbering ?? [];

  const state = states.get(rule.id) ?? [];
  const current = state[level - 1] ?? rule.start - 1;
  state[level - 1] = current + 1;
  for (let deeper = level; deeper < 9; deeper += 1) state[deeper] = 0;
  states.set(rule.id, state);

  const formats = new Map<number, string>();
  for (const item of globals.headingNumbering) {
    if (item.id === rule.id) formats.set(item.level, item.format);
  }
  for (const item of localRules) {
    if (item.id === rule.id) formats.set(item.level, item.format);
  }
  const template = rule.text ?? `%${rule.level}.`;
  const value = template.replace(/%([1-9])/g, (_match, rawLevel: string) => {
    const placeholderLevel = Number.parseInt(rawLevel, 10);
    return formatCounter(state[placeholderLevel - 1] ?? 0, formats.get(placeholderLevel) ?? 'decimal');
  });
  const suffix = rule.suffix === 'nothing' || rule.suffix === 'none' ? '' : ' ';
  return `${value}${suffix}`;
}

/** 只对块级内容生效；表格单元格由 `buildTableDecorations` 单独处理。 */
const STYLED_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bullet_list',
  'ordered_list',
  'code_block',
  'math_block',
  'table',
]);

function styleString(style: Map<string, string>): string {
  return Array.from(style.entries())
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');
}

function captionPrefix(type: string | null): string {
  if (type === 'table') return '表';
  if (type === 'figure' || type === 'fig') return '图';
  return '';
}

/** 正文已经写了“图3-1 / 表 1”，不再叠加自动编号。 */
function hasManualCaptionLabel(node: ProseMirrorNode): boolean {
  return /^\s*(图|表|Figure|Table|Fig\.?)\s*[\dA-Za-z一二三四五六七八九十]/i.test(
    node.textContent,
  );
}

function hasManualReferenceLabel(node: ProseMirrorNode, id: string | null): boolean {
  if (!id) return false;
  return node.textContent.trimStart().startsWith(`[${id}]`);
}

function breakLabel(type: string): string {
  switch (type.toLowerCase()) {
    case 'column':
      return '分栏符';
    case 'line':
    case 'textwrapping':
      return '换行符';
    default:
      return '分页符';
  }
}

/**
 * 把解析结果转成节点装饰属性。使用 `data-docx-*` 而不是 class，
 * 避免覆盖 `math-block` 等自定义 NodeView 的既有 class。
 */
function blockPresentationAttrs(
  presentation: ResolvedBlockPresentation,
  node: ProseMirrorNode,
  actualHeadingLevel: number,
  captionNumber: string | null,
  captionPrefixOverride: string | null = null,
  formulaNumberOverride: string | null = null,
): Record<string, string> | null {
  const style = new Map(presentation.style);
  const attrs: Record<string, string> = {};

  // 列表的编号位置由 `<ol>/<ul>` 自身的列表几何决定。段落指令里的正向首行
  // 缩进会随 `<ol>` 继承到每个条目上，视觉上就像编号后面按了一下 Tab；
  // 悬挂缩进（负值，配合 padding-left）是列表编号的排版依据，必须保留。
  if (node.type.name === 'ordered_list' || node.type.name === 'bullet_list') {
    const textIndent = style.get('text-indent');
    if (textIndent !== undefined && !textIndent.trim().startsWith('-')) {
      style.delete('text-indent');
    }
  }

  // 只在指令级别与 Markdown 实际标题级别不一致时提示视觉级别；
  // 否则沿用主题自身的标题字号，避免同一级别出现两套尺寸。
  if (presentation.headingLevel && presentation.headingLevel !== actualHeadingLevel) {
    attrs['data-docx-heading-level'] = String(presentation.headingLevel);
  }
  if (presentation.listFormat) attrs['data-docx-list-format'] = presentation.listFormat;
  if (style.has('--docx-tab-right')) attrs['data-docx-tabs'] = 'right';
  if (presentation.listStart != null && node.type.name === 'ordered_list') {
    attrs.start = String(presentation.listStart);
  }
  if (presentation.listLevel != null) {
    attrs['data-docx-list-level'] = String(presentation.listLevel);
  }
  if (presentation.listMarker) attrs['data-docx-list-marker'] = presentation.listMarker;

  if (presentation.image) {
    const image = presentation.image;
    attrs['data-docx-image'] = 'true';
    if (image.width) {
      attrs['data-docx-image-width'] = image.width;
      style.set('--docx-image-width', cssLength(image.width));
    }
    if (image.height) {
      attrs['data-docx-image-height'] = image.height;
      style.set('--docx-image-height', cssLength(image.height));
    }
    if (image.align) {
      attrs['data-docx-image-align'] = image.align;
      style.set('--docx-image-align', image.align);
    }
    if (image.fit) attrs['data-docx-image-fit'] = image.fit;
    if (image.wrap && image.wrap !== 'inline') {
      attrs['data-docx-image-wrap'] = image.wrap;
    }
  }

  if (presentation.caption) {
    const caption = presentation.caption;
    attrs['data-docx-caption'] = caption.type ?? 'figure';
    if (caption.type) attrs['data-docx-caption-type'] = caption.type;
    if (caption.id) {
      attrs['data-docx-caption-id'] = caption.id;
      attrs['data-docx-target'] = caption.id;
    }
    if (captionNumber) {
      attrs['data-docx-caption-number'] = captionNumber;
      const prefix = captionPrefixOverride || captionPrefix(caption.type);
      if (prefix) attrs['data-docx-caption-prefix'] = prefix;
    }
  }

  if (presentation.formula) {
    const formula = presentation.formula;
    attrs['data-docx-formula'] = 'true';
    const number = formulaNumberOverride ?? formula.number;
    if (number) attrs['data-docx-formula-number'] = number;
    if (formula.id) {
      attrs['data-docx-formula-id'] = formula.id;
      attrs['data-docx-target'] = formula.id;
    }
  }

  if (presentation.reference) {
    const reference = presentation.reference;
    attrs['data-docx-reference'] = 'true';
    if (reference.id) {
      attrs['data-docx-reference-id'] = reference.id;
      attrs['data-docx-target'] = reference.id;
      if (!hasManualReferenceLabel(node, reference.id)) {
        attrs['data-docx-reference-auto'] = 'true';
      }
    }
  }

  if (presentation.break) {
    const breakInfo = presentation.break;
    const type = breakInfo.type ?? 'page';
    const position = breakInfo.position ?? 'before';
    attrs['data-docx-break'] = position === 'after' ? 'after' : 'before';
    attrs['data-docx-break-type'] = type;
    attrs['data-docx-break-label'] = breakLabel(type);
  }

  if (style.size) attrs.style = styleString(style);
  return Object.keys(attrs).length ? attrs : null;
}

/**
 * 表格装饰：边框、表头底色、斑马纹、单元格对齐与固定列宽。
 *
 * `col.width` 的固定列宽由 TableNodeView 写入 colgroup；这里只处理视觉属性。
 */
function buildTableDecorations(
  table: ProseMirrorNode,
  tablePos: number,
  settings: TableSettings,
  globals: DocxGlobalDefinitions,
): Decoration[] {
  const decorations: Decoration[] = [];
  const wrapperStyle = new Map<string, string>();
  const wrapperAttrs: Record<string, string> = { 'data-docx-table': 'true' };

  if (settings.borderVisible?.length) {
    wrapperAttrs['data-docx-border'] = settings.borderVisible.join(' ');
    wrapperStyle.set(
      '--docx-table-border',
      `${settings.borderWidth ?? '0.5pt'} ${settings.borderStyle ?? 'solid'} ${
        settings.borderColor ?? '#000000'
      }`,
    );
  }
  if (settings.align) wrapperAttrs['data-docx-table-align'] = settings.align;
  if (settings.continuation) {
    const continuation = settings.continuation;
    wrapperAttrs['data-docx-table-continuation'] =
      continuation.startRows.length ? continuation.startRows.join(',') : 'true';
    const label = [
      '续表',
      continuation.title,
      continuation.captionId ? `#${continuation.captionId}` : null,
      continuation.startRows.length ? `拆分于第 ${continuation.startRows.join('、')} 行` : null,
    ].filter(Boolean).join(' · ');
    wrapperAttrs.title = label;
  }
  if (settings.header) {
    const bg = settings.header.get('background-color');
    if (bg) wrapperStyle.set('--docx-header-bg', bg);
    const color = settings.header.get('color');
    if (color) wrapperStyle.set('--docx-header-color', color);
    const weight = settings.header.get('font-weight');
    if (weight) wrapperStyle.set('--docx-header-font-weight', weight);
    const align = settings.header.get('text-align');
    if (align) wrapperStyle.set('--docx-header-align', align);
  }
  if (settings.body) {
    const align = settings.body.get('text-align');
    if (align) wrapperStyle.set('--docx-body-align', align);
    const valign = settings.body.get('vertical-align');
    if (valign) wrapperStyle.set('--docx-body-valign', valign);
  } else if (settings.rowVAlign) {
    wrapperStyle.set('--docx-body-valign', settings.rowVAlign);
  }
  if (settings.padding) wrapperStyle.set('--docx-table-padding', settings.padding);
  if (wrapperStyle.size) wrapperAttrs.style = styleString(wrapperStyle);

  const wrapper = wrapperAttrs as DecorationAttrs;
  decorations.push(
    Decoration.node(tablePos, tablePos + table.nodeSize, wrapper, { attrs: wrapper }),
  );

  if (settings.rowHeight) {
    let rowPos = tablePos + 1;
    for (let row = 0; row < table.childCount; row += 1) {
      const rowNode = table.child(row);
      const rowAttrs = { style: `height: ${settings.rowHeight}` };
      decorations.push(
        Decoration.node(rowPos, rowPos + rowNode.nodeSize, rowAttrs, { attrs: rowAttrs }),
      );
      rowPos += rowNode.nodeSize;
    }
  }

  const map = TableMap.get(table);
  const seen = new Set<number>();

  for (let index = 0; index < map.map.length; index += 1) {
    const offset = map.map[index]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const row = Math.floor(index / map.width);
    const column = index % map.width;
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    const style = new Map<string, string>();
    const isHeader = cell.type.name === 'table_header' || row === 0;
    if (isHeader) {
      if (settings.header) mergeStyle(style, settings.header);
    } else {
      if (settings.body) mergeStyle(style, settings.body);
      if (settings.rowVAlign) style.set('vertical-align', settings.rowVAlign);
      const dataRow = row - 1;
      const odd = dataRow % 2 === 0;
      const bg = odd ? settings.rowOddBg : settings.rowEvenBg;
      const color = odd ? settings.rowOddColor : settings.rowEvenColor;
      if (bg) style.set('background-color', bg);
      if (color) style.set('color', color);
    }
    // 显式 `@table.cell` 覆盖表头/表体与斑马纹；切片按实际表格尺寸求值，
    // 多个规则按源码顺序叠加。
    for (const rule of settings.cells) {
      if (
        selectorMatches(rule.row, row, map.height) &&
        selectorMatches(rule.column, column, map.width)
      ) {
        mergeStyle(style, rule.style);
      }
    }
    // 合并箭头仍是源文件里的文字；编辑器只降对比度提示，不伪造合并结构。
    const mergeArrow = /^[↑←→↓↗↘↖↙]$/.test(cell.textContent.trim());
    if (style.size || mergeArrow) {
      const cellAttrs: Record<string, string> = {};
      if (style.size) cellAttrs.style = styleString(style);
      if (mergeArrow) cellAttrs['data-docx-merge-arrow'] = 'true';
      // TableMap 的偏移相对表格内容起点，文档位置需再 +1（表格自身的开标签）。
      const cellPos = tablePos + 1 + offset;
      decorations.push(
        Decoration.node(cellPos, cellPos + cell.nodeSize, cellAttrs, { attrs: cellAttrs }),
      );
    }
  }

  decorations.push(...buildTableParagraphDecorations(table, tablePos, settings, globals));
  return decorations;
}

interface CellParagraphGroup {
  index: number;
  from: number;
  to: number;
}

/** 收集单元格内显式 `[[NEW | & paragraph|list]]` 组，第三维按出现顺序编号。 */
function collectCellParagraphGroups(
  cell: ProseMirrorNode,
  cellPos: number,
  globals: DocxGlobalDefinitions,
): CellParagraphGroup[] {
  const ranges: Array<{ from: number; to: number }> = [];
  const walk = (node: ProseMirrorNode, nodePos: number): void => {
    if (node.isTextblock) {
      const stack: Array<{ kind: string; from: number }> = [];
      node.forEach((child, offset) => {
        const childPos = nodePos + 1 + offset;
        if (child.type.name === 'docx_inline_open') {
          const kind = String(child.attrs.kind ?? '').toUpperCase();
          const childGroups = Array.isArray(child.attrs.groups)
            ? (child.attrs.groups as DocxGroupLike[])
            : [];
          // `& paragraph` 可能由 `use` 展开而来，需要按定义解析。
          const hasParagraphGroup = groupsHaveSemantics(
            childGroups,
            globals,
            PARAGRAPH_OR_LIST_SEMANTICS,
          );
          if (kind === 'NEW' && hasParagraphGroup) {
            stack.push({ kind, from: childPos + child.nodeSize });
          }
          return;
        }
        if (child.type.name !== 'docx_inline_close') return;
        const kind = String(child.attrs.kind ?? '').toUpperCase();
        let index = stack.length - 1;
        while (index >= 0 && stack[index]!.kind !== kind) index -= 1;
        if (index < 0) return;
        const [opened] = stack.splice(index, 1);
        if (!opened || childPos <= opened.from) return;
        ranges.push({ from: opened.from, to: childPos });
      });
      return;
    }
    node.forEach((child, offset) => walk(child, nodePos + 1 + offset));
  };
  walk(cell, cellPos);
  return ranges
    .sort((left, right) => left.from - right.from)
    .map((range, index) => ({ ...range, index }));
}

function buildTableParagraphDecorations(
  table: ProseMirrorNode,
  tablePos: number,
  settings: TableSettings,
  globals: DocxGlobalDefinitions,
): Decoration[] {
  if (!settings.paragraphs.length) return [];
  const map = TableMap.get(table);
  const seen = new Set<number>();
  const decorations: Decoration[] = [];
  for (let index = 0; index < map.map.length; index += 1) {
    const offset = map.map[index]!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const row = Math.floor(index / map.width);
    const column = index % map.width;
    const cell = table.nodeAt(offset);
    if (!cell) continue;
    const cellPos = tablePos + 1 + offset;
    const groups = collectCellParagraphGroups(cell, cellPos, globals);
    if (!groups.length) continue;
    for (const group of groups) {
      const rule = settings.paragraphs.find((candidate) =>
        selectorMatches(candidate.row, row, map.height) &&
        selectorMatches(candidate.column, column, map.width) &&
        selectorMatches(candidate.paragraph, group.index, groups.length),
      );
      if (!rule || !rule.style.size) continue;
      const attrs = { style: styleString(rule.style) };
      decorations.push(
        Decoration.inline(group.from, group.to, attrs, { attrs }),
      );
    }
  }
  return decorations;
}

interface DocxTargetInfo {
  kind: 'caption' | 'formula' | 'reference';
  label: string;
}

/** 题注手工 label（“图3-1”“表 4.1”）优先于自动编号。 */
function captionTargetLabel(
  node: ProseMirrorNode,
  caption: CaptionSettings,
  number: string | null,
  prefixOverride: string | null = null,
): string {
  const manual = /^\s*((?:图|表|Figure|Table|Fig\.?)\s*[\dA-Za-z]+(?:[.-][\dA-Za-z]+)*)/i.exec(
    node.textContent,
  );
  if (manual) return manual[1]!.replace(/\s+/g, ' ').trim();
  const prefix = prefixOverride || captionPrefix(caption.type);
  if (number) return `${prefix}${number}`;
  return node.textContent.trim().slice(0, 24);
}

interface MarkerDecorationInfo {
  attrs: DecorationAttrs;
  style: Map<string, string>;
  paragraph: boolean;
}

/** 行内标记的视觉属性；样式来自 `& font` / `& paragraph`，不写入文档。 */
function markerDecorationAttrs(
  node: ProseMirrorNode,
  globals: DocxGlobalDefinitions,
  targets: Map<string, DocxTargetInfo>,
): MarkerDecorationInfo {
  const kind = String(node.attrs.kind ?? '').toUpperCase();
  const groups = Array.isArray(node.attrs.groups)
    ? (node.attrs.groups as DocxGroupLike[])
    : [];
  const style = resolveMarkerGroupsStyle(groups, globals);
  const paragraph = groupsHaveSemantics(groups, globals, PARAGRAPH_SEMANTICS);
  const attrs: Record<string, string> = {};
  const classes = ['docx-inline-region', `docx-inline-region-${kind.toLowerCase()}`];
  // `& paragraph` 可能来自 `use` 展开，不能只看字面关键字。
  if (paragraph) {
    classes.push('docx-inline-paragraph-group');
  }
  if (kind === 'REF' || kind === 'TBL' || kind === 'FIG' || kind === 'EQ') {
    classes.push('docx-crossref');
    const name = node.attrs.name == null ? '' : String(node.attrs.name);
    if (name) {
      attrs['data-docx-target'] = name;
      const target = targets.get(name);
      if (target) {
        attrs['data-docx-target-label'] = target.label;
        attrs.title = `交叉引用 → ${target.label}`;
      } else {
        classes.push('docx-crossref-missing');
        attrs.title = `未找到引用目标：${name}`;
      }
    } else {
      attrs.title = kind;
    }
  } else if (kind === 'CMT') {
    classes.push('docx-comment-scope');
    const content = node.attrs.content == null ? '' : String(node.attrs.content);
    if (content) attrs.title = content;
  } else if (kind === 'INS') {
    classes.push('docx-revision-ins');
  } else if (kind === 'DEL') {
    classes.push('docx-revision-del');
  }
  attrs.class = classes.join(' ');
  if (style.size) {
    attrs.style = Array.from(style.entries())
      .map(([name, value]) => `${name}: ${value}`)
      .join('; ');
  }
  return { attrs, style, paragraph };
}

/** 空段落组的高度：无单位行距按 `em` 计算，其余长度原样使用。 */
function paragraphSpacerStyle(style: Map<string, string>): string {
  const lineHeight = style.get('line-height')?.trim();
  const height = !lineHeight
    ? '1em'
    : /^\d+(?:\.\d+)?$/.test(lineHeight)
      ? `calc(${lineHeight} * 1em)`
      : lineHeight;
  const parts = [`height: ${height}`];
  const marginTop = style.get('margin-top');
  if (marginTop) parts.push(`margin-top: ${marginTop}`);
  const marginBottom = style.get('margin-bottom');
  if (marginBottom) parts.push(`margin-bottom: ${marginBottom}`);
  return parts.join('; ');
}

/** 配对 `[[NEW]]...[[/NEW]]` 正文、`[[CMT]]` 批注范围等行内装饰。 */
function buildInlineMarkerDecorations(
  doc: ProseMirrorNode,
  globals: DocxGlobalDefinitions,
  targets: Map<string, DocxTargetInfo>,
): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const contentStart = pos + 1;
    const stack: Array<{
      kind: string;
      from: number;
      nodeFrom: number;
      nodeSize: number;
    } & MarkerDecorationInfo> = [];
    node.forEach((child, offset) => {
      if (child.type.name === 'docx_inline_open') {
        const info = markerDecorationAttrs(child, globals, targets);
        stack.push({
          kind: String(child.attrs.kind ?? '').toUpperCase(),
          from: contentStart + offset + child.nodeSize,
          nodeFrom: contentStart + offset,
          nodeSize: child.nodeSize,
          ...info,
        });
        return;
      }
      if (child.type.name !== 'docx_inline_close') return;
      const kind = String(child.attrs.kind ?? '').toUpperCase();
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.kind !== kind) index -= 1;
      if (index < 0) return;
      const [opened] = stack.splice(index, 1);
      if (!opened) return;
      const to = contentStart + offset;
      if (opened.paragraph) {
        // 段落组两侧的标记改成块级零高元素：留在行内会把 `<p>` 切成匿名行盒，
        // 每个逻辑段之间凭空多出一整行空白（约一行行距）。
        const marker = { class: 'docx-inline-block-marker' };
        decorations.push(
          Decoration.node(opened.nodeFrom, opened.nodeFrom + opened.nodeSize, marker),
        );
        decorations.push(Decoration.node(to, to + child.nodeSize, marker));
      }
      if (to <= opened.from) {
        // 空段落组（如 `[[NEW | & paragraph | line.spacing: 7pt]][[/NEW]]`）
        // 没有文本范围，用零宽 widget 保留它在 Word 里的间距。
        if (!opened.paragraph) return;
        const style = paragraphSpacerStyle(opened.style);
        decorations.push(
          Decoration.widget(
            to,
            () => {
              const element = document.createElement('span');
              element.className = 'docx-inline-paragraph-spacer';
              element.setAttribute('style', style);
              element.setAttribute('aria-hidden', 'true');
              return element;
            },
            {
              key: `docx-paragraph-spacer:${style}`,
              side: 1,
              ignoreSelection: true,
              stopEvent: () => true,
            },
          ),
        );
        return;
      }
      decorations.push(Decoration.inline(opened.from, to, opened.attrs, { attrs: opened.attrs }));
    });
    return false;
  });
  return decorations;
}

export function buildDocxDecorations(doc: ProseMirrorNode): DecorationSet {
  const globals = collectDocxGlobals(doc);
  const decorations: Decoration[] = [];
  const captionCounts = new Map<string, number>();
  /** 题注/公式自动编号系列 → 当前计数与章号。 */
  const captionNumberStates = new Map<string, SeriesCounter>();
  const formulaNumberStates = new Map<string, SeriesCounter>();
  /** 标题编号系列 → 各级计数器（0 基，未使用级别为 0）。 */
  const headingNumberStates = new Map<string, number[]>();
  /** `id` → 题注/公式/参考文献的可读标签，供 `[[REF | id]]` 等交叉引用悬停。 */
  const targets = new Map<string, DocxTargetInfo>();

  doc.forEach((node, offset) => {
    if (!STYLED_NODE_TYPES.has(node.type.name)) return;
    const prefix = node.attrs.docxPrefix as unknown;
    const hasPrefix = Array.isArray(prefix) && prefix.length > 0;
    // 文档级标题编号对没有本地 heading 指令的标题同样生效。
    const usesGlobalHeadingNumbering =
      node.type.name === 'heading' && globals.headingNumbering.length > 0;
    if (!hasPrefix && !usesGlobalHeadingNumbering) return;
    const lines = hasPrefix ? prefix.map((line) => String(line)) : [];
    const actualHeadingLevel = node.type.name === 'heading' ? Number(node.attrs.level ?? 0) : 0;
    const presentation = resolvePrefix(
      lines,
      globals,
      `${globals.key}\u0000${lines.join('\u0001')}`,
    );

    let captionNumber: string | null = null;
    let captionPrefixOverride: string | null = null;
    if (presentation.caption?.type) {
      const type = presentation.caption.type;
      const numbering = presentation.caption.numbering;
      const manual = hasManualCaptionLabel(node);
      // 手工 label（图3-1 / 表 1）优先；只有纯文本题注才补自动编号。
      if (numbering) {
        if (!manual) {
          captionNumber = automaticNumber(
            numbering,
            captionNumberStates,
            type,
            presentation,
            globals,
            headingNumberStates,
          );
          captionPrefixOverride = numbering.label;
        }
      } else {
        // 未启用自动编号时沿用原有顺序号；手工题注仍占一个序号。
        const count = (captionCounts.get(type) ?? 0) + 1;
        captionCounts.set(type, count);
        if (!manual) captionNumber = String(count);
      }
    }

    let formulaNumber: string | null = presentation.formula?.number ?? null;
    if (presentation.formula?.numbering && !formulaNumber) {
      formulaNumber = automaticNumber(
        presentation.formula.numbering,
        formulaNumberStates,
        'formula',
        presentation,
        globals,
        headingNumberStates,
      );
    }

    if (presentation.caption?.id) {
      targets.set(presentation.caption.id, {
        kind: 'caption',
        label: captionTargetLabel(
          node,
          presentation.caption,
          captionNumber,
          captionPrefixOverride,
        ),
      });
    }
    if (presentation.formula?.id) {
      targets.set(presentation.formula.id, {
        kind: 'formula',
        label: formulaNumber ? `(${formulaNumber})` : '公式',
      });
    }
    if (presentation.reference?.id) {
      targets.set(presentation.reference.id, {
        kind: 'reference',
        label: `[${presentation.reference.id}]`,
      });
    }

    const attrs: Record<string, string> = {
      ...(blockPresentationAttrs(
        presentation,
        node,
        actualHeadingLevel,
        captionNumber,
        captionPrefixOverride,
        formulaNumber,
      ) ?? {}),
    };
    if (node.type.name === 'heading') {
      const level = presentation.headingLevel ?? actualHeadingLevel;
      const numberText = headingNumberText(level, presentation, globals, headingNumberStates);
      if (numberText) {
        attrs['data-docx-heading-number'] = 'true';
        attrs['data-docx-heading-number-text'] = numberText;
      }
    }
    if (Object.keys(attrs).length) {
      // 同时放进 spec，便于测试/调试读取；渲染仍以 attrs 为准。
      decorations.push(
        Decoration.node(offset, offset + node.nodeSize, attrs as DecorationAttrs, { attrs }),
      );
    }
    if (presentation.table && node.type.name === 'table') {
      decorations.push(...buildTableDecorations(node, offset, presentation.table, globals));
    }
  });
  decorations.push(...buildInlineMarkerDecorations(doc, globals, targets));
  return DecorationSet.create(doc, decorations);
}

/**
 * 重建装饰时复用旧对象。
 *
 * `buildDocxDecorations` 每次都会新建 `Decoration`（连同内部的 NodeType/InlineType）。
 * prosemirror-view 判断“这个节点的装饰有没有变”用的是对象相等，于是整篇 660 个块
 * 都会被重新写一遍 DOM——即使键入的只是一个字。按“位置 + 属性”把旧对象接回去后，
 * 未受影响的块保持同一引用，视图层只更新真正变化的节点。
 */
function reuseDecorationObjects(
  previous: DecorationSet,
  next: DecorationSet,
  doc: ProseMirrorNode,
): DecorationSet {
  const stride = doc.content.size + 2;
  /** 位置 → 旧装饰。同一位置可能同时有块级与行内装饰，用数组保留。 */
  const buckets = new Map<number, Decoration[]>();
  for (const decoration of previous.find(0, doc.content.size)) {
    if (!isReusableDecoration(decoration)) continue;
    const key = decoration.from * stride + decoration.to;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(decoration);
    else buckets.set(key, [decoration]);
  }
  if (buckets.size === 0) return next;

  const decorations: Decoration[] = [];
  let reused = 0;
  for (const decoration of next.find(0, doc.content.size)) {
    const bucket = isReusableDecoration(decoration)
      ? buckets.get(decoration.from * stride + decoration.to)
      : undefined;
    const old = bucket?.find((candidate) => sameDecorationType(candidate, decoration));
    if (old) {
      decorations.push(old);
      reused += 1;
    } else {
      decorations.push(decoration);
    }
  }
  if (reused === 0) return next;
  // 全部命中说明排版没变，直接沿用旧集合（连 DecorationSet 都不用重建）。
  if (reused === decorations.length) return previous;
  return DecorationSet.create(doc, decorations);
}

/** `type` 是 prosemirror-view 的运行时内部字段，未出现在类型声明里。 */
interface DecorationTypeInfo {
  attrs?: Record<string, unknown>;
  spec?: Record<string, unknown> | null;
  toDOM?: unknown;
}

function decorationTypeInfo(decoration: Decoration): DecorationTypeInfo {
  return (decoration as unknown as { type: DecorationTypeInfo }).type;
}

/** 小组件装饰带闭包（如任务复选框的勾选态），不能跨重建复用。 */
function isReusableDecoration(decoration: Decoration): boolean {
  const type = decorationTypeInfo(decoration);
  if (type.toDOM) return false;
  return Boolean(type.attrs || type.spec);
}

function sameDecorationType(a: Decoration, b: Decoration): boolean {
  const typeA = decorationTypeInfo(a);
  const typeB = decorationTypeInfo(b);
  // 同一范围可能同时有块级与行内装饰，类不同就不能互换。
  if ((typeA as { constructor?: unknown }).constructor !== (typeB as { constructor?: unknown }).constructor) {
    return false;
  }
  return sameDecorationAttrs(typeA.attrs, typeB.attrs) && sameDecorationSpec(typeA.spec, typeB.spec);
}

function sameDecorationAttrs(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function sameDecorationSpec(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === 'attrs' ? !sameDecorationAttrs(
      a[key] as Record<string, unknown> | undefined,
      b[key] as Record<string, unknown> | undefined,
    ) : a[key] !== b[key]) return false;
  }
  return true;
}

export const docxPresentationPluginKey = new PluginKey<DecorationSet>('docxPresentation');

/** 事务 meta：强制同步重建一次装饰（输入停顿后的补算）。 */
const DOCX_PRESENTATION_REBUILD = 'docx-presentation-rebuild';
/** 论文这类文档整篇重建装饰约 20 ms，放到停顿后再算，别压在每次按键上。 */
const DOCX_PRESENTATION_REBUILD_DELAY_MS = 120;
/**
 * 纯行内文字编辑的补算间隔：连续输入时每个键都会重排定时器，因此一直不触发，
 * 真正停手 400 ms 后才补算一次。装饰里的段落样式/题注编号最多滞后一个停顿。
 */
const DOCX_PRESENTATION_INLINE_REBUILD_DELAY_MS = 400;

/**
 * 判断事务是否只是“在同一个文本块里增删/替换文字或改标记”。
 *
 * 这类编辑不改变块结构、块属性，旧装饰按 mapping 平移后位置完全正确，
 * 不需要在按键路径上重算整篇样式；只有结构/属性变化才值得尽快重算。
 */
function isInlineTextEdit(transaction: Transaction): boolean {
  for (let index = 0; index < transaction.steps.length; index += 1) {
    const step = transaction.steps[index]!;
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
    if (!(step instanceof ReplaceStep)) return false;
    const before = transaction.docs[index];
    if (!before) return false;
    if (step.slice.size > 0) {
      if (step.slice.openStart !== 0 || step.slice.openEnd !== 0) return false;
      if (step.slice.content.childCount !== 1 || !step.slice.content.firstChild!.isText) return false;
    }
    if (step.from > before.content.size) return false;
    const $from = before.resolve(step.from);
    if (!$from.parent.isTextblock) return false;
    if (step.to > step.from) {
      const $to = before.resolve(Math.min(step.to - 1, before.content.size));
      if ($to.parent !== $from.parent) return false;
    }
  }
  return true;
}

/**
 * 仅 docx 模式启用；普通 Markdown 返回空装饰集。
 *
 * 逐字输入时不再重建整篇装饰（论文约 20 ms/键，是“打字慢半拍”的主要来源）：
 * 先把旧装饰按事务映射平移，位置立刻正确；停顿 120 ms 后再重算一次，
 * 补齐新增内容的样式。结构性编辑的错误最多持续一个停顿周期。
 */
export function docxPresentationPlugin(isDocxMode: () => boolean): Plugin<DecorationSet> {
  let view: EditorView | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelRebuild = () => {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
  };

  const scheduleRebuild = (delay: number) => {
    cancelRebuild();
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      if (!view || view.isDestroyed) return;
      view.dispatch(view.state.tr.setMeta(docxPresentationPluginKey, DOCX_PRESENTATION_REBUILD));
    }, delay);
  };

  return new Plugin<DecorationSet>({
    key: docxPresentationPluginKey,
    state: {
      init: (_config, state) =>
        isDocxMode() ? buildDocxDecorations(state.doc) : DecorationSet.empty,
      apply: (transaction, value) => {
        if (!isDocxMode()) return DecorationSet.empty;
        if (transaction.getMeta(docxPresentationPluginKey) === DOCX_PRESENTATION_REBUILD) {
          return reuseDecorationObjects(value, buildDocxDecorations(transaction.doc), transaction.doc);
        }
        // 装饰只依赖文档内容：纯选区/光标事务直接复用，避免每次重建上千个装饰。
        if (!transaction.docChanged) return value;
        // 连续打字时只平移旧装饰；补算一律排到停手之后，避免每键 20 ms 的重算。
        scheduleRebuild(
          isInlineTextEdit(transaction)
            ? DOCX_PRESENTATION_INLINE_REBUILD_DELAY_MS
            : DOCX_PRESENTATION_REBUILD_DELAY_MS,
        );
        return value.map(transaction.mapping, transaction.doc);
      },
    },
    view(editorView) {
      view = editorView;
      return {
        destroy() {
          cancelRebuild();
          view = null;
        },
      };
    },
    props: {
      decorations(state) {
        if (!isDocxMode()) return null;
        return docxPresentationPluginKey.getState(state) ?? null;
      },
    },
  });
}

/**
 * 属性面板展示用的可序列化“生效排版”。
 *
 * 与装饰使用同一套 `resolvePrefix` 结果，面板里看到的字号/缩进就是正文实际效果；
 * 表头/表体/单元格的声明也一并展开，避免面板只显示表级字段。
 */
export interface DocxTableParagraphSummary {
  /** 3D 选择器的可读形式，例如 `(1, 0, 0)` 或 `(1:, :2, 0)`。 */
  selector: string;
  style: Record<string, string>;
}

export interface DocxTableContinuationSummary {
  /** 续表拆分点（正文行，1 基）。 */
  startRows: number[];
  captionId: string | null;
  title: string | null;
  style: Record<string, string> | null;
}

export interface DocxEffectiveTableSummary {
  borderVisible: string[];
  borderWidth: string | null;
  borderStyle: string | null;
  borderColor: string | null;
  align: string | null;
  colWidths: string[] | null;
  rowHeight: string | null;
  rowVAlign: string | null;
  header: Record<string, string> | null;
  body: Record<string, string> | null;
  cells: Record<string, Record<string, string>>;
  /** `@table.paragraph` 声明的单元格内段落样式。 */
  paragraphs: DocxTableParagraphSummary[];
  /** `@table.continuation` 的续表声明；编辑器只做近似展示。 */
  continuation: DocxTableContinuationSummary | null;
}

export interface DocxEffectiveSummary {
  style: Record<string, string>;
  headingLevel: number | null;
  listFormat: string | null;
  listStart: number | null;
  listLevel: number | null;
  listMarker: string | null;
  image: ImageSettings | null;
  caption: CaptionSettings | null;
  formula: FormulaSettings | null;
  reference: ReferenceSettings | null;
  break: BreakSettings | null;
  table: DocxEffectiveTableSummary | null;
}

function mapToRecord(map: Map<string, string> | null | undefined): Record<string, string> | null {
  if (!map || map.size === 0) return null;
  return Object.fromEntries(map);
}

function selectorRangeText(range: SelectorRange): string {
  if (range.from === null && range.to === null) return ':';
  if (range.from === null) return `:${range.to! + 1}`;
  if (range.to === null) return `${range.from}:`;
  return range.from === range.to ? String(range.from) : `${range.from}:${range.to + 1}`;
}

/** 读取块上的 `docxPrefix`（普通块）或 `rawLines`（`docx_meta`）。 */
export function blockDirectiveLines(node: ProseMirrorNode): string[] {
  const raw =
    node.type.name === 'docx_meta'
      ? node.attrs.rawLines
      : (node.attrs.docxPrefix ?? node.attrs.rawLines);
  if (!Array.isArray(raw)) return [];
  return raw.map((line) => String(line));
}

const globalsByDoc = new WeakMap<ProseMirrorNode, DocxGlobalDefinitions>();

function docxGlobalsFor(doc: ProseMirrorNode): DocxGlobalDefinitions {
  let globals = globalsByDoc.get(doc);
  if (!globals) {
    globals = collectDocxGlobals(doc);
    globalsByDoc.set(doc, globals);
  }
  return globals;
}

/**
 * 表格固定列宽（已展开 `use` / `var`）。
 *
 * TableNodeView 只能拿到表格节点，看不到文档级的 `var head = table | col.width: ...`；
 * 这里借助文档定义解析，避免 `<!-- use head -->` 的表格退回自动测量。
 */
export function resolveTableColumnWidths(
  doc: ProseMirrorNode,
  table: ProseMirrorNode,
): string[] | null {
  const lines = blockDirectiveLines(table);
  if (!lines.length) return null;
  const globals = docxGlobalsFor(doc);
  const resolved = resolvePrefix(
    lines,
    globals,
    `${globals.key}\u0000${lines.join('\u0001')}`,
  );
  return resolved.table?.colWidths ?? null;
}

export function summarizeDocxBlockPresentation(
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  globals: DocxGlobalDefinitions = collectDocxGlobals(doc),
): DocxEffectiveSummary {
  const lines = blockDirectiveLines(node);
  const resolved = resolvePrefix(
    lines,
    globals,
    `${globals.key}\u0000${lines.join('\u0001')}`,
  );
  const table = resolved.table;
  return {
    style: Object.fromEntries(resolved.style),
    headingLevel: resolved.headingLevel,
    listFormat: resolved.listFormat,
    listStart: resolved.listStart,
    listLevel: resolved.listLevel,
    listMarker: resolved.listMarker,
    image: resolved.image ? { ...resolved.image } : null,
    caption: resolved.caption ? { ...resolved.caption } : null,
    formula: resolved.formula ? { ...resolved.formula } : null,
    reference: resolved.reference ? { ...resolved.reference } : null,
    break: resolved.break ? { ...resolved.break } : null,
    table: table
      ? {
          borderVisible: table.borderVisible ? [...table.borderVisible] : [],
          borderWidth: table.borderWidth,
          borderStyle: table.borderStyle,
          borderColor: table.borderColor,
          align: table.align,
          colWidths: table.colWidths ? [...table.colWidths] : null,
          rowHeight: table.rowHeight,
          rowVAlign: table.rowVAlign,
          header: mapToRecord(table.header),
          body: mapToRecord(table.body),
          cells: Object.fromEntries(
            table.cells.map((rule) => [
              `(${selectorRangeText(rule.row)}, ${selectorRangeText(rule.column)})`,
              Object.fromEntries(rule.style),
            ]),
          ),
          paragraphs: table.paragraphs.map((rule) => ({
            selector: `(${selectorRangeText(rule.row)}, ${selectorRangeText(rule.column)}, ${selectorRangeText(rule.paragraph)})`,
            style: Object.fromEntries(rule.style),
          })),
          continuation: table.continuation
            ? {
                startRows: [...table.continuation.startRows],
                captionId: table.continuation.captionId,
                title: table.continuation.title,
                style: mapToRecord(table.continuation.style),
              }
            : null,
        }
      : null,
  };
}

/** 测试辅助：清空跨用例缓存。 */
export function resetDocxPresentationCachesForTests(): void {
  directiveCache.clear();
  styleCache.clear();
}
