/**
 * `.docx.md` 属性面板的上下文快照。
 *
 * 面板不直接接触 ProseMirror 事务：它拿到一个纯数据快照（含 revision），
 * 修改时把 `targetId + revision + 编辑` 交给编辑器核心；核心校验版本后
 * 用 `setNodeMarkup` 改 `docxPrefix` / `rawLines`，从而进入撤销历史。
 *
 * `targetId` 是不透明字符串：
 * - `b:<blockIndex>`：普通块（`docxPrefix`）；
 * - `b:<blockIndex>/c:<row>:<col>`：表格单元格（指令仍在表格的 `docxPrefix`）；
 * - `m:<blockIndex>`：`docx_meta`（`rawLines`）。
 */
import type { Node as ProseMirrorNode, ResolvedPos } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { parseDirectiveLine } from './directiveGrammar';
import { DOCX_META_KIND_LABELS, summarizeDirectiveLines } from './metaSummary';
import type { DocxDiagnostic, ParsedDocxDirective } from './model';
import {
  blockDirectiveLines,
  collectDocxGlobals,
  summarizeDocxBlockPresentation,
  type DocxEffectiveSummary,
  type DocxGlobalDefinitions,
} from './presentation';

export type { DocxEffectiveSummary } from './presentation';

export type DocxTargetKind =
  | 'meta'
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'table'
  | 'tableCell'
  | 'image'
  | 'caption'
  | 'formula'
  | 'reference'
  | 'block';

export interface DocxContextFieldView {
  rawName: string;
  canonicalName: string;
  value: string;
  rawValue: string;
  groupIndex: number;
  fieldIndex: number;
}

export interface DocxContextGroupView {
  rawKeyword: string;
  canonicalKeyword: string;
  globalTarget: string | null;
  fields: DocxContextFieldView[];
}

export interface DocxContextDirectiveView {
  lineIndex: number;
  raw: string;
  keyword: string;
  canonicalKeyword: string;
  globalTarget: string | null;
  body: string;
  decorator: boolean;
  groups: DocxContextGroupView[];
  diagnostics: DocxDiagnostic[];
  valid: boolean;
}

export interface DocxGlobalsSummary {
  font: Record<string, string>;
  paragraph: Record<string, string>;
  variables: string[];
}

export interface DocxDocumentEntry {
  targetId: string;
  blockIndex: number;
  kind: string;
  badge: string;
  summary: string;
  sectionIndex: number | null;
  lineCount: number;
  directives: DocxContextDirectiveView[];
}

export interface DocxTablePosition {
  row: number;
  column: number;
  rows: number;
  columns: number;
  /** 当前单元格是否由多行/多列合并而来。 */
  merged: boolean;
}

export interface DocxSelectionInfo {
  empty: boolean;
  /** 选区是否落在表格里。 */
  inTable: boolean;
}

export interface DocxEditorContext {
  revision: number;
  directivesVisible: boolean;
  targetId: string | null;
  blockIndex: number | null;
  kind: DocxTargetKind;
  label: string;
  /** 块内纯文本预览（截断）。 */
  text: string;
  directives: DocxContextDirectiveView[];
  effective: DocxEffectiveSummary | null;
  table: DocxTablePosition | null;
  meta: { kind: string; sectionIndex: number | null } | null;
  globals: DocxGlobalsSummary;
  document: DocxDocumentEntry[];
  selection: DocxSelectionInfo;
}

export interface DocxTargetRef {
  blockIndex: number;
  kind: 'block' | 'meta';
  cell: { row: number; column: number } | null;
}

const TEXT_PREVIEW_LIMIT = 40;

export function docxTargetId(
  blockIndex: number,
  kind: 'block' | 'meta',
  cell: { row: number; column: number } | null = null,
): string {
  const base = `${kind === 'meta' ? 'm' : 'b'}:${blockIndex}`;
  return cell ? `${base}/c:${cell.row}:${cell.column}` : base;
}

export function parseDocxTargetId(targetId: string): DocxTargetRef | null {
  const match = /^([bm]):(\d+)(?:\/c:(\d+):(\d+))?$/.exec(targetId);
  if (!match) return null;
  return {
    blockIndex: Number(match[2]),
    kind: match[1] === 'm' ? 'meta' : 'block',
    cell:
      match[3] != null && match[4] != null
        ? { row: Number(match[3]), column: Number(match[4]) }
        : null,
  };
}

function textPreview(node: ProseMirrorNode, limit = TEXT_PREVIEW_LIMIT): string {
  const text = node.textContent.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function directiveView(
  directive: ParsedDocxDirective,
  lineIndex: number,
): DocxContextDirectiveView {
  return {
    lineIndex,
    raw: directive.raw,
    keyword: directive.keyword,
    canonicalKeyword: directive.canonicalKeyword,
    globalTarget: directive.globalTarget,
    body: directive.body,
    decorator: directive.decorator,
    groups: directive.groups.map((group, groupIndex) => ({
      rawKeyword: group.rawKeyword,
      canonicalKeyword: group.canonicalKeyword,
      globalTarget: group.globalTarget,
      fields: group.fields.map((field, fieldIndex) => ({
        rawName: field.rawName,
        canonicalName: field.canonicalName,
        value: field.value,
        rawValue: field.rawValue,
        groupIndex,
        fieldIndex,
      })),
    })),
    diagnostics: directive.diagnostics,
    valid: true,
  };
}

function invalidDirectiveView(line: string, lineIndex: number): DocxContextDirectiveView {
  return {
    lineIndex,
    raw: line,
    keyword: '',
    canonicalKeyword: '',
    globalTarget: null,
    body: '',
    decorator: false,
    groups: [],
    diagnostics: [
      {
        code: 'DOCX_PARSE',
        severity: 'warning',
        message: '这一行以指令注释开头，但无法解析为有效指令。',
      },
    ],
    valid: false,
  };
}

/** 把 `docxPrefix` / `rawLines` 数组转成面板可编辑的指令视图。 */
export function contextDirectives(lines: readonly string[]): DocxContextDirectiveView[] {
  return lines.map((line, lineIndex) => {
    const directive = parseDirectiveLine(String(line));
    return directive ? directiveView(directive, lineIndex) : invalidDirectiveView(String(line), lineIndex);
  });
}

interface TableHit {
  row: number;
  column: number;
  rows: number;
  columns: number;
  merged: boolean;
}

function tablePositionAt(
  table: ProseMirrorNode,
  relativePos: number,
): TableHit | null {
  const map = TableMap.get(table);
  // TableMap 的偏移相对表格内容起点；`node.nodeAt` 用同一套偏移。
  let gridIndex = -1;
  for (let index = 0; index < map.map.length; index += 1) {
    const start = map.map[index]!;
    const cell = table.nodeAt(start);
    if (!cell) continue;
    if (relativePos >= start && relativePos < start + cell.nodeSize) {
      gridIndex = index;
      break;
    }
  }
  if (gridIndex < 0) return null;
  const cellStart = map.map[gridIndex]!;
  // 合并单元格在 map 中重复出现；取最左上角那一格作为坐标。
  let first = gridIndex;
  for (let index = 0; index < map.map.length; index += 1) {
    if (map.map[index] === cellStart) {
      first = index;
      break;
    }
  }
  const row = Math.floor(first / map.width);
  const column = first % map.width;
  let repeated = 0;
  for (const offset of map.map) if (offset === cellStart) repeated += 1;
  return {
    row,
    column,
    rows: map.height,
    columns: map.width,
    merged: repeated > 1,
  };
}

/** 深度 0（节点选区落在 meta/表格上）时按位置扫描顶层块。 */
function topLevelBlockIndex(doc: ProseMirrorNode, pos: number): number {
  let start = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const end = start + doc.child(index).nodeSize;
    if (pos < end) return index;
    start = end;
  }
  return Math.max(0, doc.childCount - 1);
}

function selectionTable(
  $head: ResolvedPos,
): { table: ProseMirrorNode; position: TableHit } | null {
  for (let depth = $head.depth; depth > 0; depth -= 1) {
    const node = $head.node(depth);
    if (node.type.name !== 'table') continue;
    const relative = $head.pos - $head.start(depth);
    const position = tablePositionAt(node, relative);
    return position ? { table: node, position } : null;
  }
  return null;
}

function targetKind(
  node: ProseMirrorNode,
  inTable: boolean,
  effective: DocxEffectiveSummary,
): DocxTargetKind {
  if (inTable) return 'tableCell';
  if (node.type.name === 'docx_meta') return 'meta';
  if (node.type.name === 'table') return 'table';
  if (node.type.name === 'heading') return 'heading';
  if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') return 'list';
  if (effective.caption) return 'caption';
  if (effective.formula) return 'formula';
  if (effective.reference) return 'reference';
  if (effective.image) return 'image';
  if (node.type.name === 'math_block') return 'formula';
  if (node.type.name === 'paragraph') return 'paragraph';
  return 'block';
}

function targetLabel(
  kind: DocxTargetKind,
  node: ProseMirrorNode,
  effective: DocxEffectiveSummary,
  table: TableHit | null,
  metaSummary: string,
): string {
  switch (kind) {
    case 'meta':
      return metaSummary;
    case 'heading': {
      const level = Number(node.attrs.level ?? 1);
      const text = textPreview(node, 24);
      return text ? `标题 ${level} · ${text}` : `标题 ${level}`;
    }
    case 'list': {
      const ordered = node.type.name === 'ordered_list';
      return `${ordered ? '有序' : '无序'}列表${effective.listFormat ? ` · ${effective.listFormat}` : ''}`;
    }
    case 'table':
      return table
        ? `表格 ${table.rows} × ${table.columns}`
        : '表格';
    case 'tableCell':
      return table
        ? `单元格 (${table.row + 1}, ${table.column + 1})${table.merged ? ' · 合并' : ''}`
        : '表格单元格';
    case 'caption': {
      const type = effective.caption?.type === 'table' ? '表题' : '图题';
      const text = textPreview(node, 24);
      return text ? `${type} · ${text}` : type;
    }
    case 'formula': {
      const number = effective.formula?.number;
      return number ? `公式 (${number})` : '公式';
    }
    case 'reference': {
      const id = effective.reference?.id;
      return id ? `参考文献 [${id}]` : '参考文献';
    }
    case 'image':
      return '图片';
    case 'paragraph': {
      const text = textPreview(node, 24);
      return text ? `段落 · ${text}` : '段落';
    }
    default:
      return node.type.name;
  }
}

function globalsSummary(globals: DocxGlobalDefinitions): DocxGlobalsSummary {
  return {
    font: Object.fromEntries(globals.font),
    paragraph: Object.fromEntries(globals.paragraph),
    variables: Array.from(globals.variables.keys()),
  };
}

/**
 * 面板快照的按文档缓存。
 *
 * ProseMirror 文档不可变，同一个 `doc` 对象对应的指令块视图与全局定义不会变。
 * 光标移动（`doc` 未变）时若重新扫描全文，论文的 668 个指令块每次都要重新解析
 * 并重建视图对象；缓存后只剩一次 Map 命中。
 */
const documentEntriesCache = new WeakMap<ProseMirrorNode, DocxDocumentEntry[]>();
const docxGlobalsCache = new WeakMap<ProseMirrorNode, DocxGlobalDefinitions>();

function documentEntries(doc: ProseMirrorNode): DocxDocumentEntry[] {
  const cached = documentEntriesCache.get(doc);
  if (cached) return cached;
  const entries: DocxDocumentEntry[] = [];
  doc.forEach((node, _offset, index) => {
    if (node.type.name !== 'docx_meta') return;
    const lines = blockDirectiveLines(node);
    const kind = String(node.attrs.metaKind ?? 'mixed');
    const sectionIndex = Number(node.attrs.sectionIndex) || null;
    const summaryText = summarizeDirectiveLines(kind, lines, sectionIndex);
    entries.push({
      targetId: docxTargetId(index, 'meta'),
      blockIndex: index,
      kind,
      badge: DOCX_META_KIND_LABELS[kind] ?? DOCX_META_KIND_LABELS.mixed!,
      summary: summaryText,
      sectionIndex,
      lineCount: lines.length,
      directives: contextDirectives(lines),
    });
  });
  documentEntriesCache.set(doc, entries);
  return entries;
}

function docxGlobals(doc: ProseMirrorNode): DocxGlobalDefinitions {
  const cached = docxGlobalsCache.get(doc);
  if (cached) return cached;
  const globals = collectDocxGlobals(doc);
  docxGlobalsCache.set(doc, globals);
  return globals;
}

export interface BuildDocxContextOptions {
  revision: number;
  directivesVisible: boolean;
  /** 供一次选择变化内复用，避免重复扫描全文。 */
  globals?: DocxGlobalDefinitions;
  /**
   * 面板点击结构标记时锁定到该顶层块，不移动正文选区。
   * `docx_meta` 不可选，直接设置 TextSelection 会破坏 ProseMirror 的
   * “选区端点必须在行内内容中”约束；这里用快照级目标替代。
   */
  forcedBlockIndex?: number | null;
}

/**
 * 从当前选区构建面板快照。
 *
 * 选区在表格中时，`blockIndex` 仍指最外层表格（指令挂在表格的 `docxPrefix`），
 * `targetId` 额外带单元格坐标，便于面板显示“当前单元格”的作用域。
 */
export function buildDocxContext(
  doc: ProseMirrorNode,
  head: ResolvedPos,
  empty: boolean,
  options: BuildDocxContextOptions,
): DocxEditorContext {
  const globals = options.globals ?? docxGlobals(doc);
  const blocks: DocxDocumentEntry[] = documentEntries(doc);

  if (doc.childCount === 0) {
    return {
      revision: options.revision,
      directivesVisible: options.directivesVisible,
      targetId: null,
      blockIndex: null,
      kind: 'block',
      label: '空文档',
      text: '',
      directives: [],
      effective: null,
      table: null,
      meta: null,
      globals: globalsSummary(globals),
      document: blocks,
      selection: { empty, inTable: false },
    };
  }

  const forcedIndex = options.forcedBlockIndex;
  const forced = forcedIndex != null && forcedIndex >= 0 && forcedIndex < doc.childCount;
  const blockIndex = forced
    ? forcedIndex!
    : head.depth === 0
      ? topLevelBlockIndex(doc, head.pos)
      : head.index(0);
  const node = doc.child(blockIndex);
  const selectionHit = selectionTable(head);
  // 锁定到结构块时忽略正文选区所在的表格，避免把分节条显示成“单元格”。
  const tableHit = forced ? null : selectionHit;
  const meta = node.type.name === 'docx_meta';
  const effective = meta ? null : summarizeDocxBlockPresentation(doc, node, globals);
  const summary =
    effective ??
    ({
      style: {},
      headingLevel: null,
      listFormat: null,
      listStart: null,
      listLevel: null,
      listMarker: null,
      image: null,
      caption: null,
      formula: null,
      reference: null,
      break: null,
      table: null,
    } satisfies DocxEffectiveSummary);

  const kind = targetKind(node, Boolean(tableHit), summary);
  const metaKind = meta ? String(node.attrs.metaKind ?? 'mixed') : null;
  const sectionIndex = meta ? Number(node.attrs.sectionIndex) || null : null;
  const lines = blockDirectiveLines(node);
  const metaSummary = meta
    ? `${DOCX_META_KIND_LABELS[metaKind!] ?? DOCX_META_KIND_LABELS.mixed} · ${summarizeDirectiveLines(metaKind!, lines, sectionIndex)}`.replace(/ · $/, '')
    : '';

  const tablePosition: DocxTablePosition | null = tableHit
    ? {
        row: tableHit.position.row,
        column: tableHit.position.column,
        rows: tableHit.position.rows,
        columns: tableHit.position.columns,
        merged: tableHit.position.merged,
      }
    : null;

  const targetId =
    kind === 'tableCell' && tablePosition
      ? docxTargetId(blockIndex, 'block', {
          row: tablePosition.row,
          column: tablePosition.column,
        })
      : meta
        ? docxTargetId(blockIndex, 'meta')
        : docxTargetId(blockIndex, 'block');

  return {
    revision: options.revision,
    directivesVisible: options.directivesVisible,
    targetId,
    blockIndex,
    kind,
    label: targetLabel(kind, node, summary, tableHit?.position ?? null, metaSummary),
    text: textPreview(node),
    directives: contextDirectives(lines),
    effective: meta ? null : summary,
    table: tablePosition,
    meta: meta ? { kind: metaKind!, sectionIndex } : null,
    globals: globalsSummary(globals),
    document: blocks,
    selection: { empty, inTable: Boolean(selectionHit) },
  };
}
