/**
 * `.docx.md` 静态校验。
 *
 * 只读取 Markdown 原文，不依赖 ProseMirror 视图，供属性面板和测试复用。
 * 诊断不修复、不改写任何字符；`sourceLine` 为 1-based 行号，可直接交给
 * `EditorCore.revealMarkdownLine` 跳转。
 */
import type { DocxDiagnostic, ParsedDocxDirective } from './model';
import { parseDirectiveLine } from './directiveGrammar';
import { parseInlineMarker, type ParsedDocxInlineMarker } from './inlineMarkers';
import { getRegisteredFields, KNOWN_KEYWORDS } from './directiveRegistry';

export interface DocxValidationSummary {
  diagnostics: DocxDiagnostic[];
  errorCount: number;
  warningCount: number;
  /** 文档中识别出的指令行数；用于 UI 展示“已检查 N 条指令”。 */
  directiveCount: number;
}

interface DirectiveAtLine {
  lineNumber: number;
  line: string;
  directive: ParsedDocxDirective;
}

interface Definition {
  name: string;
  lineNumber: number;
  dependencies: string[];
}

const BODY_KEYWORDS = new Set(['var', 'fun', 'use', 'import', 'snippet', '/snippet']);
const SECTION_STARTS = new Set(['nextpage', 'continuous', 'oddpage', 'evenpage']);
const TOC_TYPES = new Set(['headings', 'figures', 'tables', 'equations']);
const BREAK_TYPES = new Set(['page', 'column', 'line']);
const BREAK_POSITIONS = new Set(['before', 'after']);
const CAPTION_TYPES = new Set(['figure', 'table']);
const POSITION_KEYWORDS = new Set(['@table.cell', '@table.paragraph']);
const ID_KEYWORDS = new Set(['caption', 'formula', 'reference']);

/**
 * 随包字段快照落后于 instructions_gen.md 的官方字段。
 * 这些字段出现在官方示例里，不能报“未知字段”。
 */
const EXTRA_ALLOWED_FIELDS: Record<string, readonly string[]> = {
  table: [
    'position',
    'layout.height',
    'startRows',
    'caption.id',
    'title',
    'line.spacing',
    'indent.left',
  ],
  list: ['level', 'format', 'text', 'suffix'],
  numbering: ['level', 'format', 'text', 'suffix'],
  heading: ['format', 'text'],
  paragraph: ['en', 'style'],
  formula: [
    'inline.style',
    'inline.weight',
    'block.style',
    'block.weight',
    'format',
    'chapter.level',
    'separator',
    'restart',
  ],
};

function severityRank(severity: DocxDiagnostic['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}

class DiagnosticCollector {
  readonly diagnostics: DocxDiagnostic[] = [];

  add(
    code: DocxDiagnostic['code'],
    severity: DocxDiagnostic['severity'],
    message: string,
    sourceLine: number,
    field?: string,
  ): void {
    this.diagnostics.push({ code, severity, message, sourceLine, ...(field ? { field } : {}) });
  }
}

/** HTML 注释内部文本是否明显想写成 docx 指令（普通注释不报错）。 */
function looksLikeDirective(inner: string): boolean {
  const text = inner.trim();
  if (!text) return false;
  const match = /^(@?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(text);
  if (!match) return false;
  const head = match[1]!;
  if (head.startsWith('@') || head.startsWith('global.')) return true;
  return KNOWN_KEYWORDS.has(head);
}

function hasUnclosedDoubleQuote(text: string): boolean {
  let quote = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') quote = !quote;
  }
  return quote;
}

function hasBalancedBrackets(text: string): boolean {
  let depth = 0;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      if (depth === 0) return false;
      depth -= 1;
    }
  }
  return depth === 0;
}

/** 面板与语法切分使用同一套关键字到注册表字段表的映射。 */
function registryKeyword(rawKeyword: string, globalTarget: string | null): string {
  if (rawKeyword.startsWith('global.')) return globalTarget ?? 'global';
  if (rawKeyword.startsWith('@image.')) return 'image_decorator';
  if (rawKeyword.startsWith('@table.')) return 'table';
  if (rawKeyword === '@list.numbering' || rawKeyword === '@heading.numbering') return 'numbering';
  if (rawKeyword === '@toc.entry' || /^@toc\.h[1-9]$/.test(rawKeyword)) return 'paragraph';
  if (rawKeyword === '@page.gutter') return 'page';
  return rawKeyword;
}

function fieldValue(
  directive: ParsedDocxDirective,
  groupIndex: number,
  name: string,
): string | null {
  const group = directive.groups[groupIndex];
  if (!group) return null;
  const field = group.fields.find(
    (candidate) => candidate.canonicalName === name || candidate.rawName.toLowerCase() === name,
  );
  return field ? field.value.trim() : null;
}

function firstFieldValue(directive: ParsedDocxDirective, name: string): string | null {
  for (let index = 0; index < directive.groups.length; index += 1) {
    const value = fieldValue(directive, index, name);
    if (value !== null) return value;
  }
  return null;
}

function validateUnknownFields(
  entry: DirectiveAtLine,
  add: DiagnosticCollector['add'],
): void {
  const { directive, lineNumber } = entry;
  for (const group of directive.groups) {
    if (BODY_KEYWORDS.has(group.canonicalKeyword)) continue;
    // @toc.h* 的 font/paragraph 组会被语法切分当成字段；这里不做未知字段判断。
    if (/^@toc\.(?:entry|h[1-9])$/.test(group.rawKeyword)) continue;
    const keyword = registryKeyword(group.rawKeyword, group.globalTarget);
    const registered = getRegisteredFields(keyword);
    if (!registered) continue;
    const allowed = new Set(Object.keys(registered));
    if (allowed.size === 0) continue;
    allowed.add('decorators');
    for (const extra of EXTRA_ALLOWED_FIELDS[keyword] ?? []) allowed.add(extra);
    // 表格作用域装饰器的主属性 position 不在通用 table 字段表里。
    if (POSITION_KEYWORDS.has(group.rawKeyword) || group.rawKeyword === '@table.continuation') {
      allowed.add('position');
    }
    for (const field of group.fields) {
      if (field.canonicalName === 'decorators') continue;
      if (!allowed.has(field.canonicalName)) {
        add(
          'DOCX_UNKNOWN_FIELD',
          'warning',
          `指令 ${group.rawKeyword} 不认识字段“${field.rawName}”。`,
          lineNumber,
          field.rawName,
        );
      }
    }
  }
}

const CAPTION_NUMBER_FORMATS = new Set([
  'decimal',
  'lowerroman',
  'upperroman',
  'lowerletter',
  'upperletter',
]);

/** 内联装饰器不在普通分组循环里，编号规则单独做必填与枚举校验。 */
function validateNumberingDecorator(
  decorator: ParsedDocxDirective,
  lineNumber: number,
  add: DiagnosticCollector['add'],
): void {
  const keyword = decorator.canonicalKeyword;
  const isCaption = keyword === '@caption.numbering';
  const isFormula = keyword === '@formula.numbering';
  const isHeading = keyword === '@heading.numbering';
  if (!isCaption && !isFormula && !isHeading) return;

  const series = firstFieldValue(decorator, 'series');
  const label = firstFieldValue(decorator, 'label');
  const level = firstFieldValue(decorator, isHeading ? 'level' : 'chapter.level');
  const format = firstFieldValue(decorator, 'format');
  const restart = firstFieldValue(decorator, 'restart');
  const separator = firstFieldValue(decorator, 'separator');

  if (!isHeading && !series) {
    add('DOCX_NUMBERING', 'warning', `${keyword} 缺少必填字段 series。`, lineNumber, 'series');
  }
  if (isCaption && !label) {
    add('DOCX_NUMBERING', 'warning', '@caption.numbering 缺少必填字段 label。', lineNumber, 'label');
  }
  if (isHeading && !level) {
    add('DOCX_NUMBERING', 'warning', '@heading.numbering 缺少 level。', lineNumber, 'level');
  }
  if (level && !/^[1-9]$/.test(level)) {
    add(
      'DOCX_NUMBERING',
      'warning',
      `${keyword} 的级别“${level}”无效，应为 1–9。`,
      lineNumber,
      isHeading ? 'level' : 'chapter.level',
    );
  }
  if (format && !CAPTION_NUMBER_FORMATS.has(format.toLowerCase()) && format.toLowerCase() !== 'chinese') {
    add(
      'DOCX_NUMBERING',
      'warning',
      `${keyword} 的编号格式“${format}”无效，可用 decimal / lowerRoman / upperRoman / lowerLetter / upperLetter。`,
      lineNumber,
      'format',
    );
  }
  if (restart && !['none', 'chapter'].includes(restart.toLowerCase())) {
    add('DOCX_NUMBERING', 'warning', `${keyword} 的 restart 只能是 none 或 chapter。`, lineNumber, 'restart');
  }
  if (restart?.toLowerCase() === 'chapter' && !firstFieldValue(decorator, 'chapter.level')) {
    add(
      'DOCX_NUMBERING',
      'warning',
      `${keyword} 使用 restart: chapter 时必须同时声明 chapter.level。`,
      lineNumber,
      'chapter.level',
    );
  }
  if (separator && separator.length !== 1) {
    add('DOCX_NUMBERING', 'warning', `${keyword} 的 separator 应为单个字符。`, lineNumber, 'separator');
  }
}

function validateDirectiveSemantics(
  entry: DirectiveAtLine,
  add: DiagnosticCollector['add'],
): void {
  const { directive, lineNumber } = entry;
  const keyword = directive.canonicalKeyword;

  for (const decorator of directive.inlineDecorators) {
    validateNumberingDecorator(decorator, lineNumber, add);
  }
  if (
    directive.decorator &&
    ['@heading.numbering', '@list.numbering', '@caption.numbering', '@formula.numbering'].includes(
      keyword,
    )
  ) {
    add(
      'DOCX_ORPHAN_DECORATOR',
      'warning',
      `${keyword} 必须写在主指令的 decorators: [...] 中，独立注释没有目标绑定。`,
      lineNumber,
    );
  }

  if (keyword === 'reference') {
    const id = firstFieldValue(directive, 'id');
    if (!id) {
      add('DOCX_MISSING_ID', 'error', '参考文献指令缺少 id。', lineNumber, 'id');
    }
  }

  for (let index = 0; index < directive.groups.length; index += 1) {
    const group = directive.groups[index]!;
    if (!POSITION_KEYWORDS.has(group.rawKeyword)) continue;
    const position = fieldValue(directive, index, 'position');
    const isParagraph = group.rawKeyword === '@table.paragraph';
    if (position === null || position === '') {
      add(
        'DOCX_MISSING_POSITION',
        'error',
        isParagraph
          ? '@table.paragraph 缺少 position，例如 position: (1, 0, 0)。'
          : `${group.rawKeyword} 缺少 position，例如 position: (1, 0)。`,
        lineNumber,
        'position',
      );
    } else if (
      isParagraph
        ? !/^\(\s*(?:-?\d+|\d*\s*:\s*\d*)\s*,\s*(?:-?\d+|\d*\s*:\s*\d*)\s*,\s*(?:-?\d+|\d*\s*:\s*\d*)\s*\)$/.test(position)
        : !/^\(\s*-?\d+\s*,\s*-?\d+\s*\)$/.test(position)
    ) {
      add(
        'DOCX_TABLE_SELECTOR',
        'error',
        isParagraph
          ? `@table.paragraph 的选择器“${position}”无效，应为 (行, 列, 段落) 并可用“:”切片。`
          : `${group.rawKeyword} 的单元格选择器“${position}”无效，应为 (行, 列)。`,
        lineNumber,
        'position',
      );
    }
  }

  if (keyword === '@table.continuation') {
    const startRows = firstFieldValue(directive, 'startRows');
    const title = firstFieldValue(directive, 'title');
    if (!title) {
      add(
        'DOCX_TABLE_CONTINUATION',
        'error',
        '@table.continuation 缺少必填字段 title。',
        lineNumber,
        'title',
      );
    }
    if (!startRows) {
      add(
        'DOCX_TABLE_CONTINUATION',
        'error',
        '@table.continuation 缺少 startRows（正文行号，1 基）。',
        lineNumber,
        'startRows',
      );
    } else {
      const rows = startRows.split(',').map((part) => Number.parseInt(part.trim(), 10));
      const valid = startRows.split(',').every((part) => /^\s*\d+\s*$/.test(part)) &&
        rows.every((row, index) => row > 0 && (index === 0 || row > rows[index - 1]!));
      if (!valid) {
        add(
          'DOCX_TABLE_CONTINUATION',
          'warning',
          `续表起止行“${startRows}”无效，应为从 1 开始、严格递增的逗号分隔整数。`,
          lineNumber,
          'startRows',
        );
      }
    }
  }

  if (keyword === 'use' && !directive.body.trim()) {
    add('DOCX_USE_EMPTY', 'error', 'use 指令缺少变量或函数名。', lineNumber);
  }
  if (keyword === 'var' && !/^[A-Za-z_]\w*\s*=/.test(directive.body.trim())) {
    add(
      'DOCX_VAR_SYNTAX',
      'warning',
      'var 指令应写成“名称 = 指令”，例如 var body = font | ...。',
      lineNumber,
    );
  }
  if (keyword === 'fun' && !/^[A-Za-z_][A-Za-z0-9_-]*\s*\(/.test(directive.body.trim())) {
    add(
      'DOCX_FUN_SYNTAX',
      'warning',
      'fun 指令应写成“名称(参数) = 指令”。',
      lineNumber,
    );
  }

  if (keyword === 'section') {
    const start = firstFieldValue(directive, 'start');
    if (start && !SECTION_STARTS.has(start.toLowerCase())) {
      add(
        'DOCX_SECTION_START',
        'warning',
        `分节起始方式“${start}”无效，可用 nextPage / continuous / oddPage / evenPage。`,
        lineNumber,
        'start',
      );
    }
  }

  if (keyword === 'toc') {
    const type = firstFieldValue(directive, 'type');
    if (type && !TOC_TYPES.has(type.toLowerCase())) {
      add(
        'DOCX_TOC_TYPE',
        'warning',
        `目录类型“${type}”无效，可用 headings / figures / tables / equations。`,
        lineNumber,
        'type',
      );
    }
    const levels = firstFieldValue(directive, 'levels');
    if (levels) {
      const match = /^(\d+)\s*-\s*(\d+)$/.exec(levels);
      const from = match ? Number(match[1]) : NaN;
      const to = match ? Number(match[2]) : NaN;
      if (!match || from < 1 || to < from || to > 9) {
        add(
          'DOCX_TOC_LEVELS',
          'warning',
          `目录级别“${levels}”无效，应写成 1-3 且范围在 1–9 内。`,
          lineNumber,
          'levels',
        );
      }
    }
  }

  if (keyword === 'break') {
    const type = firstFieldValue(directive, 'type');
    if (type && !BREAK_TYPES.has(type.toLowerCase())) {
      add(
        'DOCX_BREAK_TYPE',
        'warning',
        `分隔类型“${type}”无效，可用 page / column / line。`,
        lineNumber,
        'type',
      );
    }
    const position = firstFieldValue(directive, 'position');
    if (position && !BREAK_POSITIONS.has(position.toLowerCase())) {
      add(
        'DOCX_BREAK_POSITION',
        'warning',
        `分隔位置“${position}”无效，可用 before / after。`,
        lineNumber,
        'position',
      );
    }
  }

  if (keyword === 'caption') {
    const type = firstFieldValue(directive, 'type');
    if (type && !CAPTION_TYPES.has(type.toLowerCase())) {
      add(
        'DOCX_CAPTION_TYPE',
        'warning',
        `题注类型“${type}”无效，可用 figure / table。`,
        lineNumber,
        'type',
      );
    }
  }

  // `font bold` / `reference 1` 这类漏写 `|` 的写法仍能被宽松切分，但字段不会生效。
  if (
    !BODY_KEYWORDS.has(keyword) &&
    !entry.line.includes('|') &&
    directive.body.trim()
  ) {
    add(
      'DOCX_MISSING_PIPE',
      'warning',
      `指令 ${directive.keyword} 的属性前缺少“|”，当前正文不会被当作字段。`,
      lineNumber,
    );
  }
}

function collectIds(
  directives: DirectiveAtLine[],
  add: DiagnosticCollector['add'],
): void {
  const seen = new Map<string, DirectiveAtLine>();
  for (const entry of directives) {
    if (!ID_KEYWORDS.has(entry.directive.canonicalKeyword)) continue;
    const id = firstFieldValue(entry.directive, 'id');
    if (!id) continue;
    const key = `${entry.directive.canonicalKeyword}:${id}`;
    const previous = seen.get(key);
    if (previous) {
      add(
        'DOCX_DUPLICATE_ID',
        'warning',
        `${entry.directive.canonicalKeyword} 标识“${id}”重复（首次出现在第 ${previous.lineNumber} 行）。`,
        entry.lineNumber,
        'id',
      );
    } else {
      seen.set(key, entry);
    }
  }
}

function collectDefinitions(
  directives: DirectiveAtLine[],
  add: DiagnosticCollector['add'],
): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const entry of directives) {
    const keyword = entry.directive.canonicalKeyword;
    if (keyword !== 'var' && keyword !== 'fun') continue;
    const body = entry.directive.body.trim();
    const pattern = keyword === 'var'
      ? /^([A-Za-z_][A-Za-z0-9_-]*)\s*=/
      : /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(/;
    const match = pattern.exec(body);
    if (!match) continue;
    const name = match[1]!;
    // `var a = font | ... & use b` 里的 `& use` 会被切成第二个分组，body 看不到；
    // 依赖扫描直接读整行指令正文。函数体同样可能引用其他变量/函数。
    const dependencies = useReferences(entry.directive.content);
    const existing = definitions.get(name);
    if (existing) {
      add(
        'DOCX_DUPLICATE_DEFINITION',
        'warning',
        `${keyword === 'var' ? '变量' : '函数'}“${name}”已在第 ${existing.lineNumber} 行定义。`,
        entry.lineNumber,
        name,
      );
      continue;
    }
    definitions.set(name, { name, lineNumber: entry.lineNumber, dependencies });
  }
  return definitions;
}

function useReferences(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\buse\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    names.push(match[1]!);
  }
  return names;
}

/** `use` 引用的名称：去掉函数调用实参与首尾空白（`f(1, 2)` → `f`）。 */
function useReferenceName(body: string): string {
  return /^([A-Za-z_][A-Za-z0-9_-]*)/.exec(body.trim())?.[1] ?? '';
}

function validateVariableUse(
  directives: DirectiveAtLine[],
  definitions: Map<string, Definition>,
  add: DiagnosticCollector['add'],
): void {
  for (const entry of directives) {
    const keyword = entry.directive.canonicalKeyword;
    if (keyword === 'use') {
      // `use projtitle(1pt)` 的名称是 `projtitle`，不是整串调用表达式。
      const name = useReferenceName(entry.directive.body);
      if (name && !definitions.has(name)) {
        add(
          'DOCX_UNDEFINED_USE',
          'warning',
          `use 引用了未定义的变量或函数“${name}”。`,
          entry.lineNumber,
          name,
        );
      }
    } else if (keyword === 'var') {
      for (const name of useReferences(entry.directive.body)) {
        if (!definitions.has(name)) {
          add(
            'DOCX_UNDEFINED_USE',
            'warning',
            `var 引用了未定义的变量或函数“${name}”。`,
            entry.lineNumber,
            name,
          );
        }
      }
    }
  }

  const reported = new Set<string>();
  for (const definition of definitions.values()) {
    const path: string[] = [];
    const visit = (name: string): string[] | null => {
      const offset = path.indexOf(name);
      if (offset >= 0) return [...path.slice(offset), name];
      if (path.length > 32) return null;
      path.push(name);
      for (const dependency of definitions.get(name)?.dependencies ?? []) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
      path.pop();
      return null;
    };
    const cycle = visit(definition.name);
    if (!cycle) continue;
    const key = [...new Set(cycle)].sort().join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    add(
      'DOCX_USE_CYCLE',
      'warning',
      `变量或函数循环引用：${cycle.join(' → ')}。`,
      definition.lineNumber,
    );
  }
}

function validateSections(
  directives: DirectiveAtLine[],
  lines: string[],
  add: DiagnosticCollector['add'],
): void {
  let previous: DirectiveAtLine | null = null;
  let contentSince = false;
  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber += 1) {
    const entry = directives.find((item) => item.lineNumber === lineNumber);
    if (!entry) {
      if (lines[lineNumber - 1]!.trim()) contentSince = true;
      continue;
    }
    if (entry.directive.canonicalKeyword !== 'section') continue;
    if (previous && !contentSince) {
      add(
        'DOCX_SECTION_CONFLICT',
        'warning',
        `分节指令与第 ${previous.lineNumber} 行重复，中间没有正文。`,
        lineNumber,
      );
    }
    previous = entry;
    contentSince = false;
  }
}

function validateMissingListDirective(
  lines: string[],
  directiveLines: Map<number, DirectiveAtLine>,
  hasGlobalList: boolean,
  add: DiagnosticCollector['add'],
): void {
  if (hasGlobalList) return;
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0]!;
      else if (fence === fenceMatch[1]![0]) fence = null;
      continue;
    }
    if (fence) continue;
    if (!/^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/.test(line)) continue;
    // 只在列表第一项检查，避免每个条目重复报一次。
    if (index > 0 && /^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/.test(lines[index - 1]!)) continue;

    const bound: DirectiveAtLine[] = [];
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (!lines[previous]!.trim()) continue;
      const entry = directiveLines.get(previous + 1);
      if (!entry) break;
      bound.unshift(entry);
    }
    if (bound.length === 0) {
      add(
        'DOCX_MISSING_LIST',
        'warning',
        '列表前没有 list 指令，列表符号和编号格式不会写入 Word。',
        index + 1,
      );
      continue;
    }
    const covers = bound.some((entry) => {
      const keyword = entry.directive.canonicalKeyword;
      return keyword === 'list' || keyword === 'use' || keyword === '@list.numbering';
    });
    if (!covers) {
      add(
        'DOCX_MISSING_LIST',
        'warning',
        '列表前没有 list 指令，列表符号和编号格式不会写入 Word。',
        index + 1,
      );
    }
  }
}

function isInsideCodeSpan(line: string, position: number): boolean {
  let ticks = 0;
  for (let index = 0; index < position; index += 1) {
    if (line[index] === '`') ticks += 1;
  }
  return ticks % 2 === 1;
}

interface OpenInlineMarker {
  marker: ParsedDocxInlineMarker;
  lineNumber: number;
}

function validateInlineMarkers(
  lines: string[],
  directiveLineNumbers: Set<number>,
  add: DiagnosticCollector['add'],
): void {
  let fence: string | null = null;
  const stack: OpenInlineMarker[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0]!;
      else if (fence === fenceMatch[1]![0]) fence = null;
      continue;
    }
    if (fence || directiveLineNumbers.has(lineNumber) || !line.includes('[[')) continue;

    const token = /\[\[([^\]\n]*)(\]\])?/g;
    let match: RegExpExecArray | null;
    while ((match = token.exec(line)) !== null) {
      if (!match[2]) {
        if (!isInsideCodeSpan(line, match.index)) {
          add(
            'DOCX_INLINE_UNCLOSED',
            'warning',
            '行内标记“[[”没有闭合的“]]”。',
            lineNumber,
          );
        }
        break;
      }
      if (isInsideCodeSpan(line, match.index)) continue;
      const inner = match[1] ?? '';
      const marker = parseInlineMarker(inner);
      if (!marker) continue;

      if (
        marker.kind === 'TAB' &&
        (/^\s*TAB\s*:/i.test(inner) || marker.groups.some((group) => group.fields.length > 0))
      ) {
        add(
          'DOCX_INLINE_TAB_FIELDS',
          'warning',
          'TAB 是点锚点，不接受字段；写 [[TAB]] 即可。',
          lineNumber,
        );
      }

      if (marker.role === 'open') {
        stack.push({ marker, lineNumber });
      } else if (marker.role === 'close') {
        const openIndex = [...stack].map((item) => item.marker.kind).lastIndexOf(marker.kind);
        if (openIndex < 0) {
          add(
            'DOCX_INLINE_UNMATCHED_CLOSE',
            'warning',
            `行内标记 [[/${marker.kind}]] 没有对应的开始标记。`,
            lineNumber,
          );
        } else {
          stack.splice(openIndex, 1);
        }
      }
    }
  }

  for (const open of stack) {
    add(
      'DOCX_INLINE_UNCLOSED_RANGE',
      'warning',
      `行内标记 [[${open.marker.kind}]] 没有对应的 [[/${open.marker.kind}]]。`,
      open.lineNumber,
    );
  }
}

/** 箭头指向相邻单元格的方向；区域锚点始终是箭头链末端的非箭头单元格。 */
const MERGE_ARROWS: Record<string, readonly [number, number]> = {
  '↑': [-1, 0],
  '←': [0, -1],
  '→': [0, 1],
  '↓': [1, 0],
  '↗': [-1, 1],
  '↘': [1, 1],
  '↖': [-1, -1],
  '↙': [1, -1],
};

/** 按 GFM 单元格切分，同时避开 `\|`、代码段和 `[[...]]` 内的竖线。 */
function splitTableCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let markerDepth = 0;
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '\\' && index + 1 < line.length) {
      current += char + line[index + 1]!;
      index += 1;
      continue;
    }
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (!inCode && char === '[' && line[index + 1] === '[') {
      markerDepth += 1;
      current += '[[';
      index += 1;
      continue;
    }
    if (!inCode && markerDepth > 0 && char === ']' && line[index + 1] === ']') {
      markerDepth -= 1;
      current += ']]';
      index += 1;
      continue;
    }
    if (!inCode && markerDepth === 0 && char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  // 去掉行首行尾竖线产生的空单元，但保留中间的空单元。
  if (cells.length > 0 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells;
}

function isTableDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function visibleCellText(cell: string): string {
  return cell
    .replace(/\[\[[^\]\n]*\]\]/g, '')
    .replace(/`[^`\n]*`/g, '')
    .trim();
}

interface TableRow {
  cells: string[];
  lineNumber: number;
}

/**
 * 校验箭头式合并：每个箭头必须能沿方向走到唯一锚点，且同一锚点的区域是完整矩形。
 *
 * 编辑器只做视觉提示，真正的合并由 Word 编译器完成；这里只保证源码可编译。
 */
function validateTableMergeGeometry(
  lines: string[],
  directiveLineNumbers: Set<number>,
  add: DiagnosticCollector['add'],
): void {
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0]!;
      else if (fence === fenceMatch[1]![0]) fence = null;
      continue;
    }
    if (fence || directiveLineNumbers.has(index + 1)) continue;
    if (!line.includes('|') || !isTableDelimiterRow(lines[index + 1] ?? '')) continue;

    const rows: TableRow[] = [{ cells: splitTableCells(line), lineNumber: index + 1 }];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor]!;
      if (!rowLine.trim() || !rowLine.includes('|') || rowLine.trim().startsWith('<!--')) break;
      rows.push({ cells: splitTableCells(rowLine), lineNumber: cursor + 1 });
      cursor += 1;
    }
    index = cursor - 1;

    const columns = rows[0]!.cells.length;
    if (columns === 0) continue;
    const hasArrow = rows.some((row) =>
      row.cells.some((cell) => MERGE_ARROWS[visibleCellText(cell)] !== undefined),
    );
    if (!hasArrow) continue;

    const cellAt = (row: number, column: number): string =>
      column >= columns ? '' : visibleCellText(rows[row]?.cells[column] ?? '');
    const rowLine = (row: number): number => rows[row]?.lineNumber ?? rows[0]!.lineNumber;

    for (let row = 0; row < rows.length; row += 1) {
      const extra = rows[row]!.cells.slice(columns);
      if (extra.some((cell) => MERGE_ARROWS[visibleCellText(cell)] !== undefined)) {
        add(
          'DOCX_TABLE_MERGE_GEOMETRY',
          'error',
          `第 ${row + 1} 行的合并箭头超出了表头的 ${columns} 列。`,
          rowLine(row),
        );
      }
    }

    // 解析每个单元格最终落到哪个锚点；成环或越界记为错误单元格。
    const resolved = new Map<string, string | null>();
    const errorCells = new Set<string>();
    const resolve = (row: number, column: number, path: Set<string>): string | null => {
      const key = `${row},${column}`;
      if (resolved.has(key)) return resolved.get(key)!;
      if (path.has(key)) {
        errorCells.add(key);
        return null;
      }
      const direction = MERGE_ARROWS[cellAt(row, column)];
      if (!direction) {
        resolved.set(key, key);
        return key;
      }
      const nextRow = row + direction[0];
      const nextColumn = column + direction[1];
      if (
        nextRow < 0 ||
        nextRow >= rows.length ||
        nextColumn < 0 ||
        nextColumn >= columns
      ) {
        errorCells.add(key);
        resolved.set(key, null);
        return null;
      }
      path.add(key);
      const anchor = resolve(nextRow, nextColumn, path);
      path.delete(key);
      if (anchor === null) errorCells.add(key);
      resolved.set(key, anchor);
      return anchor;
    };

    const regions = new Map<string, Array<readonly [number, number]>>();
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (MERGE_ARROWS[cellAt(row, column)] === undefined) continue;
        const anchor = resolve(row, column, new Set());
        if (!anchor) continue;
        const members = regions.get(anchor) ?? [];
        members.push([row, column]);
        regions.set(anchor, members);
      }
    }

    for (const cell of errorCells) {
      const [rowText, columnText] = cell.split(',');
      const row = Number.parseInt(rowText ?? '', 10);
      const column = Number.parseInt(columnText ?? '', 10);
      add(
        'DOCX_TABLE_MERGE_GEOMETRY',
        'error',
        `合并箭头（第 ${row + 1} 行第 ${column + 1} 列）无法走到唯一的锚点单元格；箭头越界或成环。`,
        rowLine(row),
      );
    }

    for (const [anchor, members] of regions) {
      const [anchorRow, anchorColumn] = anchor.split(',').map((part) => Number.parseInt(part, 10)) as [number, number];
      const cells: Array<readonly [number, number]> = [[anchorRow, anchorColumn], ...members];
      const minRow = Math.min(...cells.map(([row]) => row));
      const maxRow = Math.max(...cells.map(([row]) => row));
      const minColumn = Math.min(...cells.map(([, column]) => column));
      const maxColumn = Math.max(...cells.map(([, column]) => column));
      const area = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);
      if (area === cells.length) continue;
      add(
        'DOCX_TABLE_MERGE_GEOMETRY',
        'error',
        `锚点（第 ${anchorRow + 1} 行第 ${anchorColumn + 1} 列）的合并区域不是完整矩形，请补齐箭头或改为矩形范围。`,
        rowLine(anchorRow),
      );
    }
  }
}

/**
 * 校验整个 `.docx.md` 文档。
 *
 * 同一行可以产生多条诊断；结果按行号、严重级别排序，便于面板稳定展示。
 */
export function validateDocxMarkdown(markdown: string): DocxValidationSummary {
  const lines = markdown.split(/\r?\n/);
  const collector = new DiagnosticCollector();
  const add = collector.add.bind(collector);
  const directives: DirectiveAtLine[] = [];
  const directiveLines = new Map<number, DirectiveAtLine>();
  const directiveLineNumbers = new Set<number>();
  let hasGlobalList = false;
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1]![0]!;
      else if (fence === fenceMatch[1]![0]) fence = null;
      continue;
    }
    if (fence) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('<!--')) continue;

    const directive = parseDirectiveLine(line);
    if (directive) {
      const entry = { lineNumber, line, directive };
      directives.push(entry);
      directiveLines.set(lineNumber, entry);
      directiveLineNumbers.add(lineNumber);
      if (directive.keyword === 'global.list') hasGlobalList = true;
      for (const diagnostic of directive.diagnostics) {
        add(
          diagnostic.code,
          diagnostic.severity,
          diagnostic.message,
          lineNumber,
          diagnostic.field,
        );
      }
      validateUnknownFields(entry, add);
      validateDirectiveSemantics(entry, add);
      if (hasUnclosedDoubleQuote(directive.content)) {
        add('DOCX_UNCLOSED_QUOTE', 'warning', '指令里的双引号没有成对闭合。', lineNumber);
      }
      if (!hasBalancedBrackets(directive.content)) {
        add('DOCX_UNBALANCED_BRACKET', 'warning', '指令里的方括号没有成对闭合。', lineNumber);
      }
      continue;
    }

    if (trimmed.endsWith('-->')) {
      const inner = trimmed.slice(4, -3);
      if (looksLikeDirective(inner)) {
        add(
          'DOCX_DIRECTIVE_SYNTAX',
          'warning',
          '无法解析为 docx 指令，请检查关键字或属性写法。',
          lineNumber,
        );
      }
    } else {
      const inner = trimmed.slice(4);
      if (looksLikeDirective(inner)) {
        add(
          'DOCX_UNCLOSED_DIRECTIVE',
          'warning',
          '指令注释没有以“-->”闭合。',
          lineNumber,
        );
      }
    }
  }

  const definitions = collectDefinitions(directives, add);
  validateVariableUse(directives, definitions, add);
  collectIds(directives, add);
  validateSections(directives, lines, add);
  validateMissingListDirective(lines, directiveLines, hasGlobalList, add);
  validateInlineMarkers(lines, directiveLineNumbers, add);
  validateTableMergeGeometry(lines, directiveLineNumbers, add);

  const seen = new Set<string>();
  const diagnostics = collector.diagnostics
    .filter((diagnostic) => {
      const key = `${diagnostic.code}|${diagnostic.sourceLine}|${diagnostic.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        (left.sourceLine ?? 0) - (right.sourceLine ?? 0) ||
        severityRank(left.severity) - severityRank(right.severity),
    );

  return {
    diagnostics,
    errorCount: diagnostics.filter((item) => item.severity === 'error').length,
    warningCount: diagnostics.filter((item) => item.severity === 'warning').length,
    directiveCount: directives.length,
  };
}
