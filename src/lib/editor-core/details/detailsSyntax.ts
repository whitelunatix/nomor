import type MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { classifyHtmlBlock, readHtmlTag, readHtmlInlineAtom } from '../html/htmlClassifier';

export interface DetailsSource {
  summary: string;
  body: string;
  bodyOffset: number;
  end: number;
  defaultOpen: boolean;
}

/** 只识别真实标签；围栏、行内代码、注释及 pre 中的示例不能结束容器。 */
export function readDetailsSource(source: string): DetailsSource | null {
  const opening = readHtmlTag(source, 0);
  if (!opening || opening.tag !== 'details' || opening.closing || opening.selfClosing ||
      Object.keys(opening.attrs).some(key => key !== 'open')) return null;
  let cursor = opening.end;
  while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
  const summary = readHtmlTag(source, cursor);
  if (!summary || summary.tag !== 'summary' || summary.closing || Object.keys(summary.attrs).length) return null;
  const summaryEnd = /<\/summary\s*>/ig;
  summaryEnd.lastIndex = summary.end;
  const closingSummary = summaryEnd.exec(source);
  if (!closingSummary) return null;
  const title = source.slice(summary.end, closingSummary.index);
  if (!classifyHtmlBlock(`<div>${title}</div>`).editable || /<(?:br|img|span)\b/i.test(title)) return null;
  for (let start = title.indexOf('<'); start >= 0;) {
    const tag = readHtmlTag(title, start)!;
    if (tag.tag === 'a' && Object.keys(tag.attrs).some(key => !['href', 'title'].includes(key))) return null;
    start = title.indexOf('<', tag.end);
  }
  const bodyOffset = summaryEnd.lastIndex;
  cursor = bodyOffset;
  let depth = 1;
  const containerIndents = [0];
  let lineContainerIndent = 0;
  let fence: { marker: string; length: number; quoteDepth: number; indent: number } | null = null;
  while (cursor < source.length) {
    if (source[cursor] === '\\') { cursor += 2; continue; }
    const lineStart = cursor === 0 || source[cursor - 1] === '\n';
    if (lineStart) {
      const lineEnd = source.indexOf('\n', cursor);
      const end = lineEnd < 0 ? source.length : lineEnd + 1;
      const rawLine = source.slice(cursor, end);
      let line = rawLine;
      let quoteDepth = 0;
      while (/^ {0,3}>[ \t]?/.test(line)) { line = line.replace(/^ {0,3}>[ \t]?/, ''); quoteDepth++; }
      const containerIndent = containerIndents.at(-1)!;
      if (containerIndent && line.startsWith(' '.repeat(containerIndent))) line = line.slice(containerIndent);
      const list = /^( *)(?:[-+*]|\d+[.)])([ \t]+)/.exec(line);
      const listIndent = list?.[0].length ?? 0;
      lineContainerIndent = containerIndent + listIndent;
      const fenceLine = list ? line.slice(listIndent) : line;
      const match = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(fenceLine);
      if (fence) {
        // 引用/列表退出会隐式结束其中未闭合的围栏。
        if (quoteDepth < fence.quoteDepth || (line.trim() && /^ */.exec(line)![0].length < fence.indent)) fence = null;
        else {
          const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
          if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = null;
          cursor = end;
          continue;
        }
      }
      if (match && (match[1][0] !== '`' || !match[2].includes('`'))) {
        fence = { marker: match[1][0], length: match[1].length, quoteDepth, indent: listIndent };
        cursor = end;
        continue;
      }
      // 四空格缩进的字面代码也不能关闭当前层。
      if (/^(?: {4}|\t)/.test(line)) { cursor = end; continue; }
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (source[cursor] === '`') {
      const run = /^`+/.exec(source.slice(cursor))![0];
      let end = source.indexOf(run, cursor + run.length);
      while (end >= 0 && (source[end - 1] === '`' || source[end + run.length] === '`')) end = source.indexOf(run, end + run.length);
      if (end >= 0 && !/\n[ \t]*\n/.test(source.slice(cursor, end))) { cursor = end + run.length; continue; }
    }
    if (source[cursor] !== '<') { cursor++; continue; }
    const tag = readHtmlTag(source, cursor);
    if (!tag) { cursor++; continue; }
    if (!tag.closing && ['pre', 'script', 'style', 'textarea'].includes(tag.tag)) {
      const close = new RegExp(`</${tag.tag}\\s*>`, 'ig');
      close.lastIndex = tag.end;
      if (!close.exec(source)) return null;
      cursor = close.lastIndex;
      continue;
    }
    if (tag.tag === 'details') {
      depth += tag.closing ? -1 : 1;
      if (tag.closing) containerIndents.pop();
      else containerIndents.push(lineContainerIndent);
      if (!depth) return { summary: title, body: source.slice(bodyOffset, cursor), bodyOffset,
        end: tag.end, defaultOpen: Object.prototype.hasOwnProperty.call(opening.attrs, 'open') };
    }
    cursor = tag.end;
  }
  return null;
}

/** 完整 HTML 正文只接收 schema 可往返的标签/属性，未知内容整体保留。 */
export function isDetailsHtmlBody(source: string, wrappedText = false): boolean {
  if (!/^\s*<(?:p|ul|ol|pre|img|details|div)\b/i.test(source)) return false;
  const stack: string[] = [];
  const summaries: number[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (wrappedText && source.slice(cursor, start).trim() &&
      (!stack.length || ['details', 'div', 'ul', 'ol'].includes(stack.at(-1)!))) return false;
    const tag = readHtmlTag(source, start);
    if (!tag) return false;
    if (tag.closing) {
      if (stack.pop() !== tag.tag) return false;
      if (tag.tag === 'details' && summaries.pop() !== 1) return false;
    } else {
      const keys = Object.keys(tag.attrs);
      const allowed: Record<string, string[]> = { p: [], ul: [], ol: ['start'], li: [], pre: [],
        code: ['class'], details: ['open'], summary: [], div: ['data-nomo-details-body'],
        strong: [], b: [], em: [], i: [], s: [], del: [], u: [], mark: [], sub: [], sup: [], a: ['href', 'title'] };
      if (tag.tag === 'img' || tag.tag === 'br') {
        if (!readHtmlInlineAtom(tag.tag, tag.attrs)) return false;
      } else {
        if (!allowed[tag.tag] || keys.some(key => !allowed[tag.tag].includes(key)) || tag.selfClosing) return false;
        if (tag.tag === 'div' && !Object.prototype.hasOwnProperty.call(tag.attrs, 'data-nomo-details-body')) return false;
        if (tag.tag === 'code' && tag.attrs.class && !/^language-[\w+-]+$/.test(tag.attrs.class)) return false;
        if (tag.tag === 'a' && !classifyHtmlBlock(`<div>${source.slice(start, tag.end)}x</a></div>`).editable) return false;
        if (tag.tag === 'summary') {
          if (stack.at(-1) !== 'details' || summaries.at(-1) !== 0) return false;
          summaries[summaries.length - 1]++;
        }
        if (tag.tag === 'details') {
          if (!readDetailsSource(source.slice(start))) return false;
          summaries.push(0);
        }
        if (['ul', 'ol'].includes(stack.at(-1) ?? '') && tag.tag !== 'li') return false;
        if (tag.tag === 'li' && !['ul', 'ol'].includes(stack.at(-1) ?? '')) return false;
        if (stack.at(-1) === 'pre' && tag.tag !== 'code') return false;
        if (stack.at(-1) === 'code' && stack.includes('pre')) return false;
        stack.push(tag.tag);
      }
    }
    cursor = tag.end;
  }
  return stack.length === 0 && (!wrappedText || !source.slice(cursor).trim());
}

export function registerDetailsRule(md: MarkdownIt): void {
  md.block.ruler.before('html_block', 'nomo_details', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!/^<details(?:\s|>)/i.test(first)) return false;
    if (silent) return true;
    // 顶层直接读取共享源码切片；不为每个块复制余下的整篇文档。
    const source = state.parentType === 'root'
      ? state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.bMarks[endLine] ?? state.src.length)
      : state.getLines(startLine, endLine, state.blkIndent, false).trimStart();
    const parsed = readDetailsSource(source);
    if (!parsed) return false;
    const restEnd = source.indexOf('\n', parsed.end);
    const rest = source.slice(parsed.end, restEnd < 0 ? source.length : restEnd);
    if (rest.trim()) return false;
    const consumed = source.slice(0, parsed.end).split('\n').length;
    const body = parsed.body;
    // 先按块分词，HTML 仅转换自己的 token；不能因首段是 HTML 就吞掉后面的 Markdown。
    const children: Token[] = [];
    if (isDetailsHtmlBody(body, true)) {
      // 完整 HTML 的 pre 可以包含空行，不能被 Markdown 的 HTML 块终止规则拆开。
      const token = new Token('details_html_body', '', 0);
      token.content = body;
      const lines = body.split('\n');
      const first = lines.findIndex(line => line.trim());
      let last = lines.length;
      while (last > first && !lines[last - 1].trim()) last--;
      token.map = [first, last];
      children.push(token);
    } else md.block.parse(body, md, state.env, children);
    for (const token of children) {
      if (token.type !== 'html_block' || !/^\s*<(?:p|ul|ol|pre|img|div|details)\b/i.test(token.content)) continue;
      if (!isDetailsHtmlBody(token.content)) return false;
      token.type = 'details_html_body';
      token.tag = '';
    }
    const push = (type: string, tag: string, nesting: -1 | 0 | 1) => state.push(type, tag, nesting);
    const open = push('details_open', 'details', 1);
    open.attrs = parsed.defaultOpen ? [['open', '']] : [];
    open.map = [startLine, startLine + consumed];
    const title = push('details_summary_html', 'summary', 0);
    title.content = parsed.summary;
    title.map = [startLine, startLine + source.slice(0, parsed.bodyOffset).split('\n').length];
    const bodyToken = push('details_body_open', 'div', 1);
    const offset = startLine + source.slice(0, parsed.bodyOffset).split('\n').length - 1;
    bodyToken.map = [offset, startLine + consumed];
    for (const token of children) {
      if (token.map) token.map = [token.map[0] + offset, token.map[1] + offset];
      token.level += state.level;
      state.tokens.push(token);
    }
    push('details_body_close', 'div', -1);
    push('details_close', 'details', -1);
    state.line = startLine + consumed;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote'] });
}
