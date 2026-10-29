/**
 * `.docx.md` 指令模型。
 *
 * 所有 span 都是相对于指令正文（HTML 注释内部文本）的 UTF-16 偏移，
 * 用于属性面板精确替换字段值而不重排整行。
 */

export interface DocxSpan {
  from: number;
  to: number;
}

export interface DocxField {
  /** 源码中的字段名，可能带别名大小写。 */
  rawName: string;
  /** 注册表规范化后的字段名，例如 `indent.firstLine`。 */
  canonicalName: string;
  /** 源码中的字段值原文。 */
  rawValue: string;
  /** 去掉首尾空白后的值。 */
  value: string;
  /** 包含字段名、冒号和值的范围。 */
  fieldSpan: DocxSpan;
  /** 只包含值的范围；无值字段与 fieldSpan 相同。 */
  valueSpan: DocxSpan;
}

export interface DocxGroup {
  /** 源码关键字，例如 `@table.header`。 */
  rawKeyword: string;
  /** `global.` 会拆成关键字 `global` 与目标；规范化关键字不含 global 前缀。 */
  canonicalKeyword: string;
  /** `global.<target>` 的目标，例如 `page`。 */
  globalTarget: string | null;
  /**
   * 关键字之后、首个 `|` 之前的原文。
   *
   * 仅 `use` 这类 body 关键字有语义（保存被引用的变量/函数名）；
   * 普通指令里它是字段原文的一部分，不参与解析。
   */
  body: string;
  fields: DocxField[];
  span: DocxSpan;
}

export type DocxCategory =
  | 'global'
  | 'page'
  | 'section'
  | 'headerFooter'
  | 'toc'
  | 'snippet'
  | 'variable'
  | 'function'
  | 'use'
  | 'import'
  | 'font'
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'table'
  | 'image'
  | 'code'
  | 'formula'
  | 'caption'
  | 'reference'
  | 'break'
  | 'separator'
  | 'object'
  | 'shape'
  | 'unknown';

export type DocxAttach = 'block' | 'toc' | 'meta' | 'snippet';

export interface DocxDiagnostic {
  code: `DOCX_${string}`;
  severity: 'error' | 'warning' | 'info';
  message: string;
  targetId?: string;
  directiveIndex?: number;
  field?: string;
  sourceLine?: number;
}

export interface ParsedDocxDirective {
  /** 完整源码行，含 `<!--` 与 `-->`，不含行尾。 */
  raw: string;
  /** 注释内部正文，保留原始空白。 */
  content: string;
  /** content 在 raw 中的起始偏移，便于精确回写。 */
  contentStart: number;
  /** 第一个分组之前的指令体（不含关键字），用于面板展示。 */
  body: string;
  /** 主关键字，`@` 开头表示装饰器。 */
  keyword: string;
  /** 规范化关键字（无 global 前缀，别名已展开）。 */
  canonicalKeyword: string;
  /** global 目标；非 global 为 null。 */
  globalTarget: string | null;
  decorator: boolean;
  category: DocxCategory;
  attach: DocxAttach;
  groups: DocxGroup[];
  /** `decorators: [...]` 写法展开出的装饰器指令。 */
  inlineDecorators: ParsedDocxDirective[];
  diagnostics: DocxDiagnostic[];
}

export interface DocxMetaLine {
  /** 原始指令行；空行保持为空字符串。 */
  raw: string;
  directive: ParsedDocxDirective | null;
}

export interface DocxMetaGroup {
  kind: 'global' | 'page' | 'section' | 'headerFooter' | 'toc' | 'variable' | 'function' | 'snippet' | 'separator' | 'object' | 'shape' | 'import' | 'mixed';
  lines: DocxMetaLine[];
}

/** 解析结果里保留的最小绑定信息，供面板与呈现层复用。 */
export interface DocxBindingSummary {
  /** 目标块编号，用于不透明 targetId。 */
  blockIndex: number;
  prefixLines: string[];
  directives: ParsedDocxDirective[];
  metaGroups: DocxMetaGroup[];
}
