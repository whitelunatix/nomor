import {
  createMarkdownTokenizer,
  parseHtmlImgAttrs,
  WRAPPED_IMAGE_HTML,
  STANDALONE_IMAGE_HTML,
  inlineTokenSourceRange,
} from './markdownTokenizer';
import {
  analyzeInlineSource,
  escapeInlineSourceLiteral,
  isInlineSourceBlock,
  isRetainedInlineToken,
} from './InlineSourceCodec';
export { serializeMarkdown, serializeMarkdownSelection } from './markdownSerialization';
import { InputRule, textblockTypeInputRule } from 'prosemirror-inputrules';
import { createListInputRule } from './listCommands';
import Token from 'markdown-it/lib/token.mjs';
import { Fragment, type Node as ProseMirrorNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { schema, type TableColumnAlignment } from './schema';
import {
  createLinkAttrs,
  normalizeLinkHref,
  serializeMarkdownLinkDestination,
  serializeMarkdownLinkTitle,
} from './link';
import { splitFrontMatterBlock } from '../markdown/frontMatter';
import { parseWithSyncAnchors, type MarkdownSyncAnchor } from './scrollSyncMapping';
import {
  createSemanticMarkdownParser,
  type MarkdownParserWithTokenHandlers,
  type SemanticMarkdownParser,
} from './markdownParserFactory';
import { getDocxMarkdownIt, getDocxSemanticParser } from '../docxmd/docxParser';

export const markdownIt = createMarkdownTokenizer({ inlineSource: true });
const semanticParser = createSemanticMarkdownParser(markdownIt);
export const tableMarkdownParser = semanticParser.parser;
const tableMarkdownParserWithHandlers =
  tableMarkdownParser as unknown as MarkdownParserWithTokenHandlers;

export interface MarkdownParseOptions {
  /** `.docx.md` 专用解析器；普通 Markdown 走默认实例。 */
  docx?: boolean;
}

interface ResolvedMarkdownParser {
  tokenizer: typeof markdownIt;
  parser: SemanticMarkdownParser;
}

/** docx 解析器懒加载，普通 `.md` 打开时不创建第二个 markdown-it 实例。 */
function resolveMarkdownParser(docx: boolean | undefined): ResolvedMarkdownParser {
  if (docx) {
    return { tokenizer: getDocxMarkdownIt(), parser: getDocxSemanticParser() };
  }
  return { tokenizer: markdownIt, parser: semanticParser };
}

/**
 * 预处理：将 GitHub 兼容的 HTML 图片格式转换为旧 {align=center width=128} 格式，
 * 让现有 parser 统一处理。
 *   - <p align="left|center|right"><img ...></p>  → ![alt](src){align=X width=Y}
 *   - 独立一行的 <img src="..." ...>             → ![alt](src){width=Y}
 */
interface MarkdownLineProvenance {
  fromLine: number;
  toLine: number;
}

interface PreprocessedImageHtml {
  markdown: string;
  lineProvenance: MarkdownLineProvenance[];
}

interface MarkdownSourceRange {
  from: number;
  to: number;
}

/** 图片转换前按真实 token 保护字面内容，避免反引号或容器标记改变匹配边界。 */
function getImageHtmlLiteralRanges(markdown: string): MarkdownSourceRange[] {
  if (!/<img\s/i.test(markdown)) return [];
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index++) {
    if (markdown[index] === '\n') lineStarts.push(index + 1);
  }
  const ranges: MarkdownSourceRange[] = [];
  let rowMap: Token['map'] = null;
  let sourceCursor = 0;
  for (const token of markdownIt.parse(markdown, {})) {
    if (token.type === 'tr_open') rowMap = token.map;
    if (token.type === 'tr_close') rowMap = null;
    const map = token.map ?? rowMap;
    if (!map) continue;
    const from = lineStarts[map[0]] ?? markdown.length;
    const to = lineStarts[map[1]] ?? markdown.length;
    if (token.type === 'fence' || token.type === 'code_block' || (
      token.type === 'html_block' && (
        /^\s*<(?:pre|script|style|textarea)(?:\s|>|$)/i.test(token.content) ||
        (/^\s*<!--/.test(token.content) && !token.content.includes('-->'))
      )
    )) {
      ranges.push({ from, to });
      sourceCursor = to;
      continue;
    }
    if (token.type !== 'inline' && token.type !== 'html_block') continue;
    const children = token.children ?? markdownIt.parseInline(token.content, {})[0].children ?? [];
    const literals = children.filter((child) =>
      child.type === 'code_inline' || child.type === 'inline_source_code' ||
      (child.type === 'html_inline' && child.content.startsWith('<!--')),
    );
    if (!literals.length && !rowMap) {
      sourceCursor = to;
      continue;
    }

    // 行内 token 已去掉引用/列表前缀；保留原始偏移，同时还原 CRLF 和表格转义竖线。
    const sourceFrom = Math.max(sourceCursor, from + (token.meta?.statsContentColumn ?? 0));
    const sourceOffsets: number[] = [];
    let source = '';
    for (let index = sourceFrom; index < to; index++) {
      if (markdown[index] === '\r' && markdown[index + 1] === '\n') continue;
      if (rowMap && markdown[index] === '\\' && markdown[index + 1] === '|') continue;
      sourceOffsets.push(index);
      source += markdown[index] === '\0' ? '\uFFFD' : markdown[index];
    }
    const positions: number[] = [];
    const lines = token.content.split('\n');
    let cursor = 0;
    let mapped = true;
    for (let line = 0; line < lines.length; line++) {
      const offset = source.indexOf(lines[line], cursor);
      if (offset < 0) { mapped = false; break; }
      for (let index = 0; index < lines[line].length; index++) {
        positions.push(sourceOffsets[offset + index]);
      }
      cursor = offset + lines[line].length;
      if (line < lines.length - 1) {
        const newline = source.indexOf('\n', cursor);
        if (newline < 0) { mapped = false; break; }
        positions.push(sourceOffsets[newline]);
        cursor = newline + 1;
      }
    }
    sourceCursor = mapped ? (sourceOffsets[cursor - 1] ?? sourceFrom - 1) + 1 : to;
    for (const child of literals) {
      const range = inlineTokenSourceRange(child);
      const start = range && positions[range.from];
      const end = range && positions[range.to - 1];
      // 无法证明精确位置时保留整个源码块，不能冒险改写字面内容。
      ranges.push(mapped && start != null && end != null ? { from: start, to: end + 1 } : { from, to });
    }
  }
  return ranges;
}

/**
 * 图片 HTML 可能把多行源码折叠成一行 Markdown。解析器需要折叠后的文本，
 * 但块对齐必须继续使用原始源码行号，因此同时记录每一行的来源范围。
 */
function preprocessImageHtmlWithProvenance(markdown: string): PreprocessedImageHtml {
  const literalRanges = getImageHtmlLiteralRanges(markdown);
  const wrappedChanges: Array<{ end: number; delta: number }> = [];
  const collapsedRanges: Array<MarkdownLineProvenance & { transformedLine: number }> = [];
  let removedLineCount = 0;

  // 步骤1：<p align="..."><img ...></p>（单行或多行）
  let result = markdown.replace(
    WRAPPED_IMAGE_HTML,
    (_full: string, align: string, imgTag: string, offset: number) => {
      if (literalRanges.some((range) => range.from < offset + _full.length && range.to > offset)) return _full;
      const cleaned = imgTag.replace(/\/>$/, '').replace(/>$/, '').trim();
      const attrs = parseHtmlImgAttrs(cleaned);
      if (!attrs.src) return _full;
      const parts: string[] = [`align=${align.toLowerCase()}`];
      if (attrs.width) parts.push(`width=${attrs.width}`);
      const titleStr = attrs.title ? ` "${serializeMarkdownLinkTitle(attrs.title)}"` : '';
      const alt = escapeInlineSourceLiteral(attrs.alt ?? '').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
      const replacement = `![${alt}](${serializeMarkdownLinkDestination(attrs.src)}${titleStr}){${parts.join(' ')}}`;
      wrappedChanges.push({ end: offset + _full.length, delta: replacement.length - _full.length });
      const originalFromLine = getLineNumberAtOffset(markdown, offset);
      const originalToLine = getLineNumberAtOffset(markdown, offset + _full.length - 1);
      collapsedRanges.push({
        transformedLine: originalFromLine - removedLineCount,
        fromLine: originalFromLine,
        toLine: originalToLine,
      });
      removedLineCount += originalToLine - originalFromLine;
      return replacement;
    },
  );
  const wrappedLiteralRanges = literalRanges.map((range) => {
    const delta = wrappedChanges.reduce((total, change) => change.end <= range.from ? total + change.delta : total, 0);
    return { from: range.from + delta, to: range.to + delta };
  });

  const wrappedProvenance = Array.from(
    { length: countMarkdownLines(result) },
    (_value, index): MarkdownLineProvenance => {
      const transformedLine = index + 1;
      const collapsedRange = collapsedRanges.find((range) => range.transformedLine === transformedLine);
      if (collapsedRange) return { fromLine: collapsedRange.fromLine, toLine: collapsedRange.toLine };
      const removedBeforeLine = collapsedRanges.reduce(
        (total, range) => range.transformedLine < transformedLine ? total + range.toLine - range.fromLine : total, 0,
      );
      const originalLine = transformedLine + removedBeforeLine;
      return { fromLine: originalLine, toLine: originalLine };
    },
  );
  const wrappedMarkdown = result;
  const standaloneRanges: Array<{ line: number; from: number; to: number }> = [];
  let standaloneRemoved = 0;
  // 步骤2：保留原有图片转换行为，同时记录被空白匹配吞并的行。
  result = result.replace(
    STANDALONE_IMAGE_HTML,
    (imgTag: string, offset: number) => {
      const tagEnd = imgTag.lastIndexOf('>') + 1;
      if (wrappedLiteralRanges.some((range) => range.from < offset + tagEnd && range.to > offset)) return imgTag;
      // 末尾空白还承担后续字面块的分隔，不能折叠掉代码块所需的空行或缩进。
      const trailing = wrappedLiteralRanges.some((range) => range.to > offset + tagEnd && (
        range.from < offset + imgTag.length || /^\s*$/.test(wrappedMarkdown.slice(offset + imgTag.length, range.from))
      ))
        ? imgTag.slice(tagEnd) : '';
      const cleaned = imgTag.replace(/\/>$/, '').replace(/>$/, '').trim();
      if (/<[^>]+<[^>]+>/.test(cleaned)) return imgTag; // 含嵌套标签，不处理
      const attrs = parseHtmlImgAttrs(cleaned);
      if (!attrs.src) return imgTag;
      const parts: string[] = [];
      if (attrs.width) parts.push(`width=${attrs.width}`);
      const titleStr = attrs.title ? ` "${serializeMarkdownLinkTitle(attrs.title)}"` : '';
      const alt = escapeInlineSourceLiteral(attrs.alt ?? '').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
      const attrsStr = parts.length > 0 ? `{${parts.join(' ')}}` : '';
      const from = getLineNumberAtOffset(wrappedMarkdown, offset);
      const to = getLineNumberAtOffset(wrappedMarkdown, offset + imgTag.length - trailing.length);
      standaloneRanges.push({ line: from - standaloneRemoved, from, to });
      standaloneRemoved += to - from;
      return `![${alt}](${serializeMarkdownLinkDestination(attrs.src)}${titleStr})${attrsStr}${trailing}`;
    },
  );

  let removedBeforeLine = 0;
  let rangeIndex = 0;
  const lineProvenance = Array.from(
    { length: countMarkdownLines(result) },
    (_value, index): MarkdownLineProvenance => {
      const transformedLine = index + 1;
      const range = standaloneRanges[rangeIndex];
      if (range?.line === transformedLine) {
        rangeIndex += 1;
        removedBeforeLine += range.to - range.from;
        return { fromLine: wrappedProvenance[range.from - 1].fromLine,
          toLine: wrappedProvenance[range.to - 1].toLine };
      }
      return wrappedProvenance[index + removedBeforeLine];
    },
  );

  return { markdown: result, lineProvenance };
}

function preprocessImageHtml(markdown: string): string {
  return preprocessImageHtmlWithProvenance(markdown).markdown;
}

function getLineNumberAtOffset(value: string, offset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(offset, value.length));
  for (let index = 0; index < end; index += 1) {
    if (value.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function countMarkdownLines(value: string): number {
  return value.split(/\r?\n/).length;
}

export function normalizeImageSrc(value: unknown): string {
  const src = String(value ?? '').trim();
  if (!src || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src)) return src;
  let decoded = src;
  try {
    // 与资源后端一致：解码有效 %XX，保留其它百分号。
    decoded = decodeURIComponent(src.replace(/%(?![\da-f]{2})/gi, '%25'));
  } catch {
    // 无效 UTF-8 与资源后端一致，保留原值用于保守比较。
  }
  const slashPath = decoded.replace(/\\/g, '/');
  const absolute = slashPath.startsWith('/');
  const parts: string[] = [];
  for (const part of slashPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

/** 复用真实 tokenizer 收集原始图片地址；null 表示无法证明无引用，禁止资源清理。 */
export function collectMarkdownImageSrcs(markdown: string): Set<string> | null {
  try {
    const { body } = splitMarkdownDocument(markdown);
    const tokens = markdownIt.parse(preprocessImageHtml(body), {});
    const srcs = new Set<string>();
    for (const token of tokens) {
      // 原始 HTML 使用另一解析边界，不能据此推断图片已无引用。
      if (token.type === 'html_block' || !tableMarkdownParserWithHandlers.tokenHandlers[token.type])
        return null;
      if (token.type !== 'inline') continue;
      const events = (token.children ?? [])
        .filter(isRetainedInlineToken)
        .map((child) => ({ token: child, range: inlineTokenSourceRange(child) }));
      if (
        events.some(
          ({ range }) =>
            !range || range.from < 0 || range.to > token.content.length || range.to < range.from,
        )
      )
        return null;
      const sorted = events.sort((a, b) => a.range!.from - b.range!.from);
      let cursor = 0;
      for (const event of sorted) {
        if (event.range!.from < cursor) continue;
        const child = event.token;
        if (child.type === 'html_inline') return null;
        if (
          !(child.type === 'text_special' && child.info === 'entity') &&
          !tableMarkdownParserWithHandlers.tokenHandlers[child.type]
        )
          return null;
        if (child.type === 'image') {
          const src = child.attrGet('src');
          if (!src || !normalizeImageSrc(src)) return null;
          srcs.add(src);
          // 图片的子 token 属于替代文本，不能算作额外的图片节点。
        }
        cursor = event.range!.to;
      }
    }
    return srcs;
  } catch {
    return null;
  }
}

/** 返回实际解析结果；失败明确返回 null，不能用字面回退结果执行删除。 */
export function tryParseMarkdown(
  markdown: string,
  options: { exportImageSources?: boolean; docx?: boolean } = {},
): ProseMirrorNode | null {
  const { tokenizer, parser } = resolveMarkdownParser(options.docx);
  const validateLink = tokenizer.validateLink;
  if (options.exportImageSources) {
    // Word 需要读取临时/内嵌图片。只在本次同步解析期间接受这些图片来源；
    // 超链接仍由 createLinkAttrs 独立过滤，默认编辑解析及序列化策略不变。
    tokenizer.validateLink = (href) => validateLink(href) ||
      /^(?:data:image\/(?:png|jpe?g|gif|webp|svg\+xml);|blob:|asset:|file:)/i.test(href);
  }
  parser.resetInlineStack();
  try {
    const { frontMatterPrefix, body } = splitMarkdownDocument(markdown);
    const parsed = parser.parser.parse(preprocessImageHtml(body));
    return parsed.type.create({ ...parsed.attrs, frontMatterPrefix }, parsed.content, parsed.marks);
  } catch {
    return null;
  } finally {
    tokenizer.validateLink = validateLink;
    parser.resetInlineStack();
  }
}
/** 仅使用真实 tokenizer 与纯图片预处理建立源码行映射，可在无 DOM 的源码大纲环境调用。 */
export function tokenizeMarkdownWithSourceLines(
  markdown: string,
  options: MarkdownParseOptions = {},
): {
  tokens: Token[];
  sourceLine: (line: number) => number;
} {
  const { tokenizer } = resolveMarkdownParser(options.docx);
  const { body } = splitMarkdownDocument(markdown);
  const preprocessed = preprocessImageHtmlWithProvenance(body);
  const lineOffset = markdown.slice(0, markdown.length - body.length).split('\n').length - 1;
  return {
    tokens: tokenizer.parse(preprocessed.markdown, {}),
    sourceLine: (line) => (preprocessed.lineProvenance[line]?.fromLine ?? line + 1) + lineOffset,
  };
}

export function parseMarkdown(markdown: string, options: MarkdownParseOptions = {}): ProseMirrorNode {
  const parsed = tryParseMarkdown(markdown, options);
  if (parsed) return parsed;
  const { frontMatterPrefix, body: rawBody } = splitMarkdownDocument(markdown);
  return schema.node('doc', { frontMatterPrefix }, [
    schema.node(
      'paragraph',
      null,
      rawBody
        ? [schema.text(rawBody, [schema.marks.inline_source.create({ literal: true })])]
        : undefined,
    ),
  ]);
}

export interface MarkdownBlockLineMap {
  fromLine: number;
  toLine: number;
  nodeIndex: number;
}

/** 返回与实际解析节点绑定的嵌套来源映射；解析失败时不提供猜测锚点。 */
export function parseMarkdownWithSyncAnchors(
  markdown: string,
  options: MarkdownParseOptions = {},
): {
  doc: ProseMirrorNode;
  anchors: MarkdownSyncAnchor[];
} {
  const { parser } = resolveMarkdownParser(options.docx);
  parser.resetInlineStack();
  const { frontMatterPrefix, body } = splitMarkdownDocument(markdown);
  const preprocessed = preprocessImageHtmlWithProvenance(body);
  const bodyOffset = markdown.length - body.length;
  const lineOffset = markdown.slice(0, bodyOffset).split('\n').length - 1;
  try {
    const result = parseWithSyncAnchors(parser.parser, preprocessed.markdown, (line, end) => {
      const provenance = preprocessed.lineProvenance[line];
      return provenance ? (end ? provenance.toLine : provenance.fromLine) + lineOffset : undefined;
    });
    return {
      doc: result.doc.type.create({ ...result.doc.attrs, frontMatterPrefix }, result.doc.content, result.doc.marks),
      anchors: result.anchors,
    };
  } catch {
    return { doc: parseMarkdown(markdown, options), anchors: [] };
  }
}

/**
 * 使用与语义编辑器相同的 markdown-it 配置建立源码行到顶层文档块的临时映射。
 * 该映射只用于导航，不参与文档解析或持久化。
 */
export function getMarkdownBlockLineMap(
  markdown: string,
  options: MarkdownParseOptions = {},
): MarkdownBlockLineMap[] {
  const { frontMatter, body } = splitFrontMatter(markdown);
  const bodyOffset = body ? markdown.indexOf(body, frontMatter.length) : markdown.length;
  const bodyStartLineOffset =
    (bodyOffset >= 0 ? markdown.slice(0, bodyOffset) : '').split('\n').length - 1;
  const preprocessed = preprocessImageHtmlWithProvenance(body);
  const { tokenizer } = resolveMarkdownParser(options.docx);
  const tokens = tokenizer.parse(preprocessed.markdown, {});

  return tokens
    .filter((token) => token.level === 0 && token.nesting >= 0 && token.map)
    .map((token, nodeIndex): MarkdownBlockLineMap | null => {
      const [fromLineIndex, toLineIndex] = token.map!;
      const fromProvenance = preprocessed.lineProvenance[fromLineIndex];
      const toProvenance = preprocessed.lineProvenance[toLineIndex - 1];
      if (!fromProvenance || !toProvenance) return null;
      return {
        fromLine: fromProvenance.fromLine + bodyStartLineOffset,
        toLine: toProvenance.toLine + bodyStartLineOffset,
        nodeIndex,
      };
    })
    .filter((mapping): mapping is MarkdownBlockLineMap => mapping !== null);
}

export function splitFrontMatter(markdown: string): { frontMatter: string; body: string } {
  return splitFrontMatterBlock(markdown);
}

function splitMarkdownDocument(markdown: string): { frontMatterPrefix: string; body: string } {
  const { frontMatter, body } = splitFrontMatterBlock(markdown);
  if (!frontMatter) {
    return { frontMatterPrefix: '', body };
  }

  const suffix = markdown.slice(frontMatter.length);
  const bodyOffset = body ? suffix.indexOf(body) : suffix.length;
  const separator = bodyOffset >= 0 ? suffix.slice(0, bodyOffset) : '';
  return { frontMatterPrefix: `${frontMatter}${separator}`, body };
}


function createTableMarkdown(rows: number, columns: number): string {
  const columnCount = Math.max(2, Math.min(columns, 6));
  const rowCount = Math.max(1, Math.min(rows, 8));
  const headers = Array.from({ length: columnCount }, () => '');
  const separator = Array.from({ length: columnCount }, () => '---');
  const body = Array.from({ length: rowCount }, () => headers.map(() => ''));
  const lines = [headers, separator, ...body].map((cells) => `| ${cells.join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

function getTableCellAttrs(token: { attrGet(name: string): string | null }): {
  align: TableColumnAlignment | null;
} {
  const style = token.attrGet('style') ?? '';
  const match = /text-align\s*:\s*(left|center|right)/i.exec(style);
  return { align: match ? (match[1].toLowerCase() as TableColumnAlignment) : null };
}

export function createMarkdownInputRules() {
  return [
    createMathInlineInputRule(),
    textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
      level: match[1].length,
    })),
    createListInputRule(),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    createHorizontalRuleInputRule(),
  ];
}

function createMathInlineInputRule(): InputRule {
  return new InputRule(/\$(?:\\.|[^\\$])+\$$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const block = $start.parent;
    if (block.type.spec.code || block.type.name === 'details_summary') return null;

    // 美元边界与解析器一致，保留 TeX 内的转义，不消耗公式前的正文。
    const before = block.textBetween(0, $start.parentOffset, '\ufffc', '\ufffc');
    const slashCount = before.match(/\\+$/)?.[0].length ?? 0;
    if (slashCount % 2 === 1 || before.endsWith('$')) return null;
    const tex = match[0].slice(1, -1).trim();
    if (!tex) return null;

    // 原文式代码与旧 code mark 均不能通过输入规则转换为语义公式。
    if (
      state.doc.rangeHasMark(start, end, schema.marks.code) ||
      (state.storedMarks ?? state.selection.$from.marks()).some((mark) => mark.type === schema.marks.code)
    ) return null;
    const fromOffset = $start.parentOffset;
    const toOffset = end - $start.start();
    if (
      isInlineSourceBlock(block) &&
      analyzeInlineSource(block).spans.some(
        (span) => span.type === 'code' && fromOffset < span.closeTo && toOffset > span.openFrom,
      )
    ) return null;

    // 仅继承整个被替换范围共有的语义 marks；inline_source 只描述文本载荷。
    let marks = ($start.nodeAfter?.marks ?? $start.marks()).filter((mark) => mark.type !== schema.marks.inline_source);
    state.doc.nodesBetween(start, end, (node) => {
      if (node.isInline) marks = marks.filter((mark) => mark.isInSet(node.marks));
    });
    const node = schema.nodes.math_inline.create({ tex }, null, block.type.allowedMarks(marks));
    return state.tr.replaceWith(start, end, node);
  });
}

/**
 * 输入 `---` 或 `___` 时转为水平分割线。
 *
 * 不用 `***`：它和加粗/斜体语法冲突，打 `****` 准备包一层加粗时，
 * 第三个 `*` 就会被吃成分割线。分割线请用短横线，或从菜单插入。
 */
function createHorizontalRuleInputRule(): InputRule {
  return new InputRule(/^(-{3,}|_{3,})$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if (
      !state.selection.empty ||
      $start.parent.type !== schema.nodes.paragraph ||
      !$start.sameParent(state.selection.$to) ||
      $start.parentOffset !== 0 ||
      end !== $start.end()
    ) return null;

    const hrNode = schema.nodes.horizontal_rule.create();
    const emptyParagraph = schema.nodes.paragraph.create();
    const replacement = Fragment.fromArray([hrNode, emptyParagraph]);
    const parentDepth = $start.depth - 1;
    const paragraphIndex = $start.index(parentDepth);
    // 只替换当前合法段落，不让 fitting 将非法块提升到表格或其他容器外。
    if (!$start.node(parentDepth).canReplace(paragraphIndex, paragraphIndex + 1, replacement)) {
      return null;
    }
    const blockStart = $start.before($start.depth);
    const tr = state.tr.replaceWith(blockStart, $start.after($start.depth), replacement);
    return tr.setSelection(TextSelection.create(tr.doc, blockStart + hrNode.nodeSize + 1));
  });
}
