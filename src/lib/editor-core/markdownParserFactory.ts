/**
 * 语义 Markdown 解析器工厂。
 *
 * 普通 `.md` 与 `.docx.md` 共用同一套 token → ProseMirror 节点映射，
 * 但各自持有独立的 markdown-it 实例与 HTML 内联栈。普通文档的行为
 * 与改造前完全一致；docx 模式只额外安装指令 token 规则。
 */
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { defaultMarkdownParser, MarkdownParser } from 'prosemirror-markdown';
import { DOMParser as PmDOMParser, Fragment, type Mark as ProseMirrorMark, type Node as ProseMirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { schema } from './schema';
import { classifyHtmlBlock, readHtmlInlineAtom, readHtmlTag } from './html/htmlClassifier';
import { parseHtmlContent } from './html/htmlToPmLogic';
import { parseHtmlAnchorAttrs, createHtmlAnchorAttrs } from './html/htmlAnchor';
import { createLinkAttrs } from './link';
import { calloutParserTokens } from './callout/calloutParser';
import {
  escapeInlineSourceLiteral,
  isRetainedInlineToken,
  materializeInlineSource,
} from './InlineSourceCodec';
import { inlineTokenSourceRange, parseHtmlAttributes } from './markdownTokenizer';
import { parseTextColorOpenTag } from './textColor';
import { parseDetailsHtml } from './details/detailsSchema';

export type HtmlMarkdownParseState = {
  openNode(type: unknown, attrs?: unknown): void;
  addNode(type: unknown, attrs?: unknown, content?: Fragment): void;
  closeNode(): void;
  openMark(mark: unknown): void;
  closeMark(markType: unknown): void;
  addText(text: string): void;
};

export type MarkdownParserWithTokenHandlers = MarkdownParser & {
  tokenHandlers: Record<string, (state: HtmlMarkdownParseState, tok: Token) => void>;
};

export interface SemanticMarkdownParser {
  parser: MarkdownParserWithTokenHandlers;
  /** 每次同步解析前清空 HTML 标签栈。 */
  resetInlineStack(): void;
  /** 允许 docx 层在 token 解析阶段扩充 handler。 */
  addTokenHandler(type: string, handler: (state: HtmlMarkdownParseState, tok: Token) => void): void;
  getTokenHandler(type: string): ((state: HtmlMarkdownParseState, tok: Token) => void) | undefined;
}

const COMMENT_RE = /^<!--([\s\S]*?)-->$/;

/** 内联标签到 ProseMirror mark 类型的映射 */
const INLINE_MARK_MAP: Record<string, string> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  code: 'code',
  a: 'link',
  s: 'strikethrough',
  del: 'strikethrough',
  strike: 'strikethrough',
  u: 'underline',
  mark: 'highlight',
  sup: 'superscript',
  sub: 'subscript',
  kbd: 'kbd',
};

/** 图片替代文字保留全部显示内容，格式开闭token不计入文字。 */
function readImageAltText(token: Token): string {
  if (token.children) return token.children.map(readImageAltText).join('');
  if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
  return token.nesting === 0 ? token.content : '';
}

function getTableCellAttrs(token: { attrGet(name: string): string | null }): {
  align: 'left' | 'center' | 'right' | null;
} {
  const style = token.attrGet('style') ?? '';
  const match = /text-align\s*:\s*(left|center|right)/i.exec(style);
  return { align: match ? (match[1].toLowerCase() as 'left' | 'center' | 'right') : null };
}

function findLastIndex<T>(arr: T[], predicate: (value: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function extractAttr(rawTag: string, name: string): string | null {
  return parseHtmlAttributes(rawTag).find(([key]) => key === name)?.[1] ?? null;
}

function getHtmlAnchorAttrs(rawTag: string) {
  return parseHtmlAnchorAttrs(rawTag);
}

function getHtmlInlineCommentContent(rawTag: string): string | null {
  if (!/^<span(?:\s|>)/i.test(rawTag)) return null;
  const classes = extractAttr(rawTag, 'class')?.split(/\s+/) ?? [];
  return classes.includes('comment-inline') ? extractAttr(rawTag, 'data-comment') : null;
}

function isMarkdownComment(content: string): boolean {
  const match = COMMENT_RE.exec(content.trim());
  if (!match) return false;
  const commentContent = match[1]!;
  return !commentContent.includes('<!--') && !commentContent.includes('-->');
}

function isReservedTocComment(content: string): boolean {
  const trimmed = content.trim();
  return /^<!--[^\S\r\n]*toc[^\S\r\n]*-->\s*$/i.test(trimmed) || /^<!--[^\S\r\n]*\/toc[^\S\r\n]*-->\s*$/i.test(trimmed);
}

function isSingleLineMarkdownComment(content: string): boolean {
  return !content.trim().includes('\n');
}

function readMarkdownCommentContent(rawComment: string): string {
  const match = COMMENT_RE.exec(rawComment.trim());
  if (!match) return rawComment;
  const content = match[1]!.replace(/\r\n/g, '\n');
  if (/^\n[\s\S]*\n$/.test(content)) return content.slice(1, -1);
  return content.replace(/^[ \t]?/, '').replace(/[ \t]?$/, '');
}

export function createSemanticMarkdownParser(markdownIt: MarkdownIt): SemanticMarkdownParser {
  const parser = new MarkdownParser(schema, markdownIt, {
    ...defaultMarkdownParser.tokens,
    ordered_list: {
      ...defaultMarkdownParser.tokens.ordered_list,
      getAttrs: (tok, tokens, index) => ({
        ...defaultMarkdownParser.tokens.ordered_list.getAttrs!(tok, tokens, index),
        order: Number(tok.attrGet('start') ?? 1),
      }),
    },
    toc_block: { node: 'toc_block', getAttrs: (tok: Token) => ({ content: tok.content }) },
    link_open: {
      mark: 'link',
      getAttrs: (tok: Token) =>
        createLinkAttrs(tok.attrGet('href'), tok.attrGet('title')) ?? { href: '', title: null },
    },
    table: { block: 'table' },
    tr: { block: 'table_row' },
    th: { block: 'table_header', getAttrs: getTableCellAttrs },
    td: { block: 'table_cell', getAttrs: getTableCellAttrs },
    footnote_ref: {
      node: 'footnote_ref',
      getAttrs: (tok: Token) => ({ id: tok.meta?.id ?? tok.content }),
    },
    footnote_def: { block: 'footnote_def', getAttrs: (tok: Token) => ({ id: tok.meta?.id ?? '' }) },
    math_inline: { node: 'math_inline', getAttrs: (tok: Token) => ({ tex: tok.content }) },
    math_display: { node: 'math_block', getAttrs: (tok: Token) => ({ tex: tok.content }) },
    code_inline: { mark: 'code' },
    image: {
      node: 'image',
      getAttrs: (tok: Token) => ({
        src: tok.attrGet('src'),
        title: tok.attrGet('title') || null,
        alt: tok.children ? tok.children.map(readImageAltText).join('') : tok.attrGet('alt') ?? '',
        align: tok.attrGet('align') || null,
        width: tok.attrGet('width') || null,
      }),
    },
    ...calloutParserTokens,
    details: { block: 'details', getAttrs: (tok) => ({ defaultOpen: tok.attrGet('open') !== null }) },
    details_body: { block: 'details_body' },
    details_summary_html: { ignore: true },
    details_html_body: { ignore: true },
    superscript: { mark: 'superscript' },
    subscript: { mark: 'subscript' },
    s: { mark: 'strikethrough' },
    s_open: { mark: 'strikethrough' },
    s_close: { mark: 'strikethrough' },
    html_block: { ignore: true },
    html_inline: { ignore: true },
  }) as MarkdownParserWithTokenHandlers;

  let htmlInlineStack: Array<{ tag: string; markName: string; mark?: ProseMirrorMark }> = [];
  const resetInlineStack = () => {
    htmlInlineStack = [];
  };
  const defaultFenceTokenHandler = parser.tokenHandlers.fence;
  const defaultImageTokenHandler = parser.tokenHandlers.image;

  parser.tokenHandlers = {
    ...parser.tokenHandlers,
    details_summary_html: (state, tok) => {
      const root = document.createElement('div');
      const paragraph = document.createElement('p');
      paragraph.innerHTML = tok.content;
      root.append(paragraph);
      const inline = PmDOMParser.fromSchema(schema).parse(root, { preserveWhitespace: true }).firstChild?.content ?? Fragment.empty;
      const summary = materializeInlineSource(schema.nodes.details_summary!.create(null, inline));
      state.addNode(summary.type, summary.attrs, summary.content);
    },
    details_html_body: (state, tok) => {
      const root = document.createElement('div');
      root.innerHTML = tok.content;
      parseDetailsHtml(root, schema).forEach((node) => {
        const content = materializeInlineSource(node);
        state.addNode(content.type, content.attrs, content.content);
      });
    },
    softbreak: (state) => {
      state.openNode(schema.nodes.hard_break, { soft: true });
      state.closeNode();
    },
    link_open: (state, tok) => {
      // 裸链接需要额外的 auto 标记，普通 `[文本](地址)` 保持默认值。
      const attrs = createLinkAttrs(tok.attrGet('href'), tok.attrGet('title'));
      state.openMark(
        schema.marks.link.create({
          href: attrs?.href ?? '',
          title: attrs?.title ?? null,
          auto: tok.meta?.autoLink === true,
        }),
      );
    },
    fence: (state, tok) => {
      const language = tok.info.trim().split(/\s+/)[0]?.toLowerCase();
      if (language === 'mermaid') {
        state.openNode(schema.nodes.mermaid_block, { code: tok.content.replace(/\n$/, '') });
        state.closeNode();
        return;
      }
      defaultFenceTokenHandler!(state, tok);
    },
    html_block: (state, tok) => {
      const table = parseSemanticTableHtml(tok.content);
      if (table) {
        state.addNode(table.type, table.attrs, table.content);
        return;
      }
      if (isMarkdownComment(tok.content) && !isReservedTocComment(tok.content)) {
        const content = readMarkdownCommentContent(tok.content);
        if (isSingleLineMarkdownComment(tok.content)) {
          state.openNode(schema.nodes.paragraph);
          state.openNode(schema.nodes.comment_inline, { content });
          state.closeNode();
          state.closeNode();
        } else {
          state.openNode(schema.nodes.comment_block, { content });
          state.closeNode();
        }
        return;
      }

      const classification = classifyHtmlBlock(tok.content);
      if (classification.editable) {
        const attrs: Record<string, unknown> = {
          tag: classification.tag!,
          class: classification.attrs?.class ?? null,
          id: classification.attrs?.id ?? null,
        };
        state.openNode(schema.nodes.html_block, attrs);
        parseHtmlContent(state, classification.innerHTML!, schema);
        state.closeNode();
      } else {
        state.openNode(schema.nodes.paragraph);
        state.openMark(schema.marks.inline_source.create({ literal: true }));
        state.addText(tok.content.trimEnd());
        state.closeMark(schema.marks.inline_source);
        state.closeNode();
      }
    },
    html_inline: (state, tok) => {
      const content = tok.content;

      if (isMarkdownComment(content) && !isReservedTocComment(content)) {
        state.openNode(schema.nodes.comment_inline, {
          content: readMarkdownCommentContent(content),
        });
        state.closeNode();
        return;
      }

      const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(content);
      if (!tagMatch) {
        state.addText(content);
        return;
      }

      const tag = tagMatch[1]!.toLowerCase();
      const isClosing = content.startsWith('</');
      const isSelfClosing = /\/>$/.test(content);

      if (tag === 'br') {
        state.openNode(schema.nodes.hard_break, {
          soft: extractAttr(content, 'data-nomo-break') === 'soft',
        });
        state.closeNode();
        return;
      }

      if (isSelfClosing) {
        const attrs = tag === 'a' ? getHtmlAnchorAttrs(content) : null;
        if (attrs) {
          state.openNode(schema.nodes.html_anchor, attrs);
          state.closeNode();
        } else state.addText(content);
        return;
      }

      const markName = INLINE_MARK_MAP[tag];

      if (isClosing) {
        const idx = findLastIndex(htmlInlineStack, (entry) => entry.tag === tag);
        if (idx >= 0) {
          while (htmlInlineStack.length > idx) {
            const top = htmlInlineStack.pop()!;
            if (top.mark) state.closeMark(top.mark);
            else if (top.markName) state.closeMark(schema.marks[top.markName]!);
          }
        } else {
          state.addText(content);
        }
        return;
      }

      if (tag === 'span') {
        const color = parseTextColorOpenTag(content);
        if (color) {
          const mark = schema.marks.text_color.create({ color });
          htmlInlineStack.push({ tag, markName: 'text_color', mark });
          state.openMark(mark);
        } else {
          // 普通 span 仍是可表示的行内标签，但关闭时不能误关外层颜色。
          htmlInlineStack.push({ tag, markName: '' });
          state.addText(content);
        }
        return;
      }

      if (markName) {
        const markType = schema.marks[markName]!;
        let attrs: Record<string, unknown> | null = null;
        if (markName === 'link') {
          const linkAttrs = getHtmlAnchorAttrs(content);
          attrs = linkAttrs ? { ...linkAttrs } : null;
          if (!attrs) {
            state.addText(content);
            return;
          }
        }
        const mark = markType.create(attrs);
        htmlInlineStack.push({ tag, markName });
        state.openMark(mark);
      } else {
        state.addText(content);
      }
    },
    inline: (state, token) => {
      const source = token.content;
      let cursor = 0;
      const appendSource = (text: string) => {
        if (!text) return;
        state.openMark(schema.marks.inline_source.create());
        state.addText(text);
        state.closeMark(schema.marks.inline_source);
      };
      const events = (token.children ?? [])
        .filter((child, index, children) =>
          isRetainedInlineToken(child) ||
          (child.type === 'html_inline' && (
            (getHtmlInlineCommentContent(child.content) !== null &&
              children[index + 1]?.type === 'html_inline' && /^<\/span\s*>$/i.test(children[index + 1]!.content)) ||
            (/^<\/span\s*>$/i.test(child.content) &&
              children[index - 1]?.type === 'html_inline' && getHtmlInlineCommentContent(children[index - 1]!.content) !== null)
          )),
        )
        .map((child) => ({ token: child, range: inlineTokenSourceRange(child) }))
        .filter((event): event is { token: Token; range: { from: number; to: number } } =>
          event.range != null && event.range.from >= 0 && event.range.to <= source.length,
        )
        .sort((a, b) => a.range.from - b.range.from);
      for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        if (event.range.from < cursor) continue;
        appendSource(source.slice(cursor, event.range.from));
        const next = events[index + 1];
        const commentContent = event.token.type === 'html_inline'
          ? getHtmlInlineCommentContent(event.token.content) : null;
        if (
          commentContent !== null && next?.token.type === 'html_inline' &&
          /^<\/span\s*>$/i.test(next.token.content) && event.range.to === next.range.from
        ) {
          state.openNode(schema.nodes.comment_inline, { content: commentContent });
          state.closeNode();
          cursor = next.range.to;
          index++;
          continue;
        }
        if (
          event.token.type === 'html_inline' && /^<a(?:\s|>)/i.test(event.token.content) &&
          next?.token.type === 'html_inline' && /^<\/a\s*>$/i.test(next.token.content) &&
          event.range.to === next.range.from
        ) {
          const attrs = getHtmlAnchorAttrs(event.token.content);
          if (attrs) {
            state.openNode(schema.nodes.html_anchor, attrs);
            state.closeNode();
            cursor = next.range.to;
            index++;
            continue;
          }
        }
        if (event.token.type === 'text_special' && event.token.info === 'entity') {
          appendSource(escapeInlineSourceLiteral(event.token.content));
        } else {
          parser.tokenHandlers[event.token.type]!(state, event.token);
        }
        cursor = event.range.to;
      }
      appendSource(source.slice(cursor));
    },
    image: (state, tok) => {
      defaultImageTokenHandler?.(state, tok);
    },
  };

  function parseSemanticTableHtml(raw: string): ProseMirrorNode | null {
    const html = raw.trim();
    if (!/^<table\s/i.test(html)) return null;
    let offset = 0;
    const decode = (text: string) => markdownIt.utils.unescapeAll(text.replace(/\\/g, '\\\\'));
    interface SemanticTableHtmlElement {
      tag: string;
      attrs: Record<string, string>;
      children: Array<string | SemanticTableHtmlElement>;
    }
    const readElement = (): SemanticTableHtmlElement | null => {
      const opening = readHtmlTag(html, offset);
      if (!opening || opening.closing) return null;
      offset = opening.end;
      const element: SemanticTableHtmlElement = { tag: opening.tag, attrs: opening.attrs, children: [] };
      if (opening.tag === 'br' || opening.tag === 'img') return element;
      if (opening.selfClosing) return null;
      while (offset < html.length) {
        if (html[offset] !== '<') {
          const end = html.indexOf('<', offset);
          if (end < 0) return null;
          element.children.push(decode(html.slice(offset, end)));
          offset = end;
          continue;
        }
        const tag = readHtmlTag(html, offset);
        if (!tag) return null;
        if (tag.closing) {
          if (tag.tag !== opening.tag) return null;
          offset = tag.end;
          return element;
        }
        const child = readElement();
        if (!child) return null;
        element.children.push(child);
      }
      return null;
    };
    const onlyAttrs = (element: SemanticTableHtmlElement, names: string[]) =>
      Object.keys(element.attrs).every((name) => names.includes(name));
    const elements = (element: SemanticTableHtmlElement): SemanticTableHtmlElement[] | null => {
      if (element.children.some((child) => typeof child === 'string' && child.trim() !== '')) return null;
      return element.children.filter((child): child is SemanticTableHtmlElement => typeof child !== 'string');
    };
    const inline = (
      children: SemanticTableHtmlElement['children'],
      marks: readonly ProseMirrorMark[] = [],
    ): ProseMirrorNode[] | null => {
      const nodes: ProseMirrorNode[] = [];
      for (const child of children) {
        if (typeof child === 'string') {
          if (child) nodes.push(schema.text(child, marks));
          continue;
        }
        const atom = readHtmlInlineAtom(child.tag, child.attrs);
        if (atom) {
          const text = child.children.every((entry) => typeof entry === 'string') ? child.children.join('') : null;
          const expected = atom.type === 'math_inline' ? '$' + atom.attrs.tex + '$' :
            atom.type === 'comment_inline' ? atom.attrs.content : atom.type === 'footnote_ref' ? atom.attrs.id : '';
          if (text !== expected) return null;
          nodes.push(schema.nodes[atom.type]!.createChecked(atom.attrs, null, marks));
          continue;
        }
        if (child.tag === 'a') {
          if (!onlyAttrs(child, ['href', 'title', 'id', 'name'])) return null;
          const attrs = createHtmlAnchorAttrs(child.attrs.href ?? null, child.attrs.title ?? null, child.attrs.id ?? null, child.attrs.name ?? null);
          if (!attrs) return null;
          if (!child.children.length) {
            nodes.push(schema.nodes.html_anchor!.createChecked(attrs, null, marks));
            continue;
          }
          const linkAttrs = child.attrs.id !== undefined || child.attrs.name !== undefined ? attrs :
            createLinkAttrs(child.attrs.href, child.attrs.title);
          if (!linkAttrs) return null;
          const nested = inline(child.children, schema.marks.link!.create(linkAttrs).addToSet(marks));
          if (!nested) return null;
          nodes.push(...nested);
          continue;
        }
        const markType = schema.marks[INLINE_MARK_MAP[child.tag]!];
        if (!markType || !onlyAttrs(child, [])) return null;
        const nested = inline(child.children, markType.create().addToSet(marks));
        if (!nested) return null;
        nodes.push(...nested);
      }
      return nodes;
    };
    try {
      const table = readElement();
      if (!table || offset !== html.length || table.tag !== 'table' ||
          table.attrs['data-nomo-table'] !== 'semantic' || !onlyAttrs(table, ['data-nomo-table'])) return null;
      const bodies = elements(table);
      if (!bodies || bodies.length !== 1 || bodies[0]!.tag !== 'tbody' || !onlyAttrs(bodies[0]!, [])) return null;
      const rows = elements(bodies[0]!);
      if (!rows?.length) return null;
      const rowNodes: ProseMirrorNode[] = [];
      for (const row of rows) {
        if (row.tag !== 'tr' || !onlyAttrs(row, [])) return null;
        const cells = elements(row);
        if (!cells) return null;
        const cellNodes: ProseMirrorNode[] = [];
        for (const cell of cells) {
          if (!['td', 'th'].includes(cell.tag) || !onlyAttrs(cell, ['colspan', 'rowspan', 'data-colwidth', 'data-align'])) return null;
          const colspan = Number(cell.attrs.colspan ?? 1), rowspan = Number(cell.attrs.rowspan ?? 1);
          if (!Number.isSafeInteger(colspan) || colspan < 1 || !Number.isSafeInteger(rowspan) || rowspan < 1) return null;
          const colwidth = cell.attrs['data-colwidth'] === undefined ? null : cell.attrs['data-colwidth'].split(',').map(Number);
          if (colwidth && (colwidth.length !== colspan || colwidth.some((width) => !Number.isSafeInteger(width) || width < 0))) return null;
          const align = cell.attrs['data-align'] ?? null;
          if (align !== null && !['left', 'center', 'right'].includes(align)) return null;
          const paragraphs = elements(cell);
          if (!paragraphs?.length) return null;
          const paragraphNodes: ProseMirrorNode[] = [];
          for (const paragraph of paragraphs) {
            if (paragraph.tag !== 'p' || !onlyAttrs(paragraph, [])) return null;
            const content = inline(paragraph.children);
            if (!content) return null;
            paragraphNodes.push(schema.nodes.paragraph!.createChecked(null, content));
          }
          cellNodes.push((cell.tag === 'th' ? schema.nodes.table_header : schema.nodes.table_cell)!
            .createChecked({ colspan, rowspan, colwidth, align }, paragraphNodes));
        }
        rowNodes.push(schema.nodes.table_row!.createChecked(null, cellNodes));
      }
      const node = schema.nodes.table!.createChecked(null, rowNodes);
      node.check();
      if (TableMap.get(node).problems) return null;
      return materializeInlineSource(node);
    } catch {
      return null;
    }
  }

  return {
    parser,
    resetInlineStack,
    addTokenHandler(type, handler) {
      parser.tokenHandlers[type] = handler;
    },
    getTokenHandler(type) {
      return parser.tokenHandlers[type];
    },
  };
}
