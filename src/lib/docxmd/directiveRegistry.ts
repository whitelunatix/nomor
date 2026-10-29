/**
 * `.docx.md` 指令关键字与字段注册表。
 *
 * 关键字集合来自 word-operation 的 `tools_forward/config.py`，字段别名与
 * 规范化名字来自 `docxml_go/directive_fields.json`（随包快照）。
 * 语法规范参考 `resource_files/instructions_gen.md`。
 */
import rawFields from './data/directive-fields.json';
import type { DocxAttach, DocxCategory } from './model';

export interface RegisteredField {
  canonical: string;
  /** block = 只能写在块级主指令，group = 也可写进 `& group`。 */
  contexts: readonly string[];
}

interface DirectiveFieldsJson {
  bare_groups: string[];
  directive_aliases: Record<string, Record<string, string>>;
  directives: Record<string, Record<string, { canonical: string; contexts: string[] }>>;
  group_aliases: Record<string, Record<string, string>>;
  group_keyword: Record<string, string>;
}

const fieldRegistry = rawFields as unknown as DirectiveFieldsJson;

/** `@` 装饰器目标。见 config.py `DECORATOR_TARGETS`。 */
export const TABLE_DECORATORS = new Set([
  '@table.header',
  '@table.body',
  '@table.cell',
  '@table.paragraph',
  '@table.continuation',
]);
export const IMAGE_DECORATORS = new Set([
  '@image.inline',
  '@image.square',
  '@image.tight',
  '@image.through',
  '@image.topAndBottom',
]);
export const TOC_DECORATORS = new Set([
  ...Array.from({ length: 9 }, (_unused, index) => `@toc.h${index + 1}`),
  '@toc.entry',
]);
export const PAGE_DECORATORS = new Set(['@page.gutter']);
export const NUMBERING_DECORATORS = new Set(['@list.numbering', '@heading.numbering']);
export const CAPTION_NUMBERING_DECORATOR = '@caption.numbering';
export const FORMULA_NUMBERING_DECORATOR = '@formula.numbering';

export const DECORATOR_KEYWORDS = new Set([
  ...TABLE_DECORATORS,
  ...IMAGE_DECORATORS,
  ...TOC_DECORATORS,
  ...PAGE_DECORATORS,
  ...NUMBERING_DECORATORS,
  CAPTION_NUMBERING_DECORATOR,
  FORMULA_NUMBERING_DECORATOR,
]);

/** 支持 `decorators: [...]` 的主指令及其允许的装饰器。 */
export const DECORATOR_TARGETS: Record<string, ReadonlySet<string>> = {
  table: TABLE_DECORATORS,
  image: IMAGE_DECORATORS,
  toc: TOC_DECORATORS,
  page: PAGE_DECORATORS,
  list: new Set(['@list.numbering']),
  heading: new Set(['@heading.numbering']),
  caption: new Set([CAPTION_NUMBERING_DECORATOR]),
  formula: new Set([FORMULA_NUMBERING_DECORATOR]),
};

/** 官方前向解析器接受的关键字。额外补充 var/fun/use/import/snippet。 */
export const KNOWN_KEYWORDS = new Set([
  'font',
  'paragraph',
  'heading',
  'list',
  'table',
  'code',
  ...TABLE_DECORATORS,
  ...IMAGE_DECORATORS,
  ...TOC_DECORATORS,
  ...PAGE_DECORATORS,
  ...NUMBERING_DECORATORS,
  CAPTION_NUMBERING_DECORATOR,
  FORMULA_NUMBERING_DECORATOR,
  'image',
  'shape',
  'page',
  'header',
  'footer',
  'toc',
  'break',
  'separator',
  'section',
  'object',
  'formula',
  'reference',
  'caption',
  'global',
  'var',
  'fun',
  'use',
  'import',
  'snippet',
  '/snippet',
]);

/** 只能作为独立行出现的结构指令。 */
export const META_KEYWORDS = new Set([
  'global',
  'page',
  'section',
  'header',
  'footer',
  'toc',
  'var',
  'fun',
  'separator',
  'object',
  'shape',
  'snippet',
  '/snippet',
  'import',
]);

const META_DECORATORS = new Set([...TOC_DECORATORS, ...PAGE_DECORATORS]);

/** 结构性指令的类别；用于 `docx_meta` 分组与呈现。 */
export function categoryOf(keyword: string, globalTarget: string | null): DocxCategory {
  if (keyword === 'global') {
    const target = globalTarget ?? '';
    if (target === 'page') return 'page';
    if (target === 'header' || target === 'footer') return 'headerFooter';
    if (target === 'toc') return 'toc';
    if (target === 'font') return 'font';
    if (target === 'paragraph') return 'paragraph';
    if (target === 'heading') return 'heading';
    if (target === 'list') return 'list';
    if (target === 'table') return 'table';
    if (target === 'image') return 'image';
    if (target === 'formula') return 'formula';
    if (target === 'caption') return 'caption';
    if (target === 'shape') return 'shape';
    if (target === 'section') return 'section';
    return 'global';
  }
  switch (keyword) {
    case 'page':
      return 'page';
    case 'section':
      return 'section';
    case 'header':
    case 'footer':
      return 'headerFooter';
    case 'toc':
      return 'toc';
    case 'snippet':
    case '/snippet':
      return 'snippet';
    case 'var':
      return 'variable';
    case 'fun':
      return 'function';
    case 'use':
      return 'use';
    case 'import':
      return 'import';
    case 'font':
      return 'font';
    case 'paragraph':
      return 'paragraph';
    case 'heading':
      return 'heading';
    case 'list':
      return 'list';
    case 'table':
      return 'table';
    case 'image':
      return 'image';
    case 'code':
      return 'code';
    case 'formula':
      return 'formula';
    case 'caption':
      return 'caption';
    case 'reference':
      return 'reference';
    case 'break':
      return 'break';
    case 'separator':
      return 'separator';
    case 'object':
      return 'object';
    case 'shape':
      return 'shape';
    default:
      break;
  }
  if (TABLE_DECORATORS.has(keyword)) return 'table';
  if (IMAGE_DECORATORS.has(keyword)) return 'image';
  if (TOC_DECORATORS.has(keyword)) return 'toc';
  if (PAGE_DECORATORS.has(keyword)) return 'page';
  if (keyword === '@formula.numbering') return 'formula';
  if (keyword === CAPTION_NUMBERING_DECORATOR) return 'caption';
  if (keyword === '@heading.numbering') return 'heading';
  if (keyword === '@list.numbering') return 'list';
  return 'unknown';
}

/** 指令绑定到后续内容块，还是保留为结构节点。 */
export function attachOf(keyword: string, globalTarget: string | null): DocxAttach {
  if (keyword === 'global') return 'meta';
  // toc 需要在绑定阶段单独成段（吸收前面的 font/paragraph/@toc.*）。
  if (keyword === 'toc') return 'toc';
  if (META_KEYWORDS.has(keyword)) return 'meta';
  if (META_DECORATORS.has(keyword)) return 'meta';
  void globalTarget;
  return 'block';
}

export function isKnownDirectiveKeyword(keyword: string): boolean {
  return KNOWN_KEYWORDS.has(keyword);
}

/** 字段别名（块级主指令）。 */
export function canonicalFieldName(keyword: string, rawName: string): string {
  const table = fieldRegistry.directive_aliases[keyword];
  return table?.[rawName] ?? rawName;
}

/** `& group` 内的字段别名。 */
export function canonicalGroupFieldName(keyword: string, rawName: string): string {
  const alias = fieldRegistry.group_aliases[keyword]?.[rawName]
    ?? fieldRegistry.directive_aliases[keyword]?.[rawName];
  return alias ?? rawName;
}

export function getRegisteredFields(keyword: string): Readonly<Record<string, RegisteredField>> | null {
  const table = fieldRegistry.directives[keyword];
  if (!table) return null;
  return table as unknown as Record<string, RegisteredField>;
}

export function getBareGroups(): readonly string[] {
  return fieldRegistry.bare_groups;
}

export function getGroupKeyword(group: string): string {
  return fieldRegistry.group_keyword[group] ?? group;
}
