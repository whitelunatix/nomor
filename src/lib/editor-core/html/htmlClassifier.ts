import { EDITABLE_BLOCK_TAGS, EDITABLE_INLINE_TAGS, DANGEROUS_TAGS } from './htmlPolicy';
import { parseHtmlAttributes } from '../markdownTokenizer';
import { normalizeLinkHref } from '../link';
import { createHtmlAnchorAttrs } from './htmlAnchor';

export interface HtmlBlockClassification {
  editable: boolean;
  /** 块级标签名 */
  tag?: string;
  /** 开闭标签之间的 HTML 内容 */
  innerHTML?: string;
  /** 提取的属性 */
  attrs?: Record<string, string>;
}

interface HtmlTag {
  tag: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
}

/** HTML 原子节点仅放行 schema 能完整往返的属性，不把普通 span/sup 当成原子节点。 */
export function readHtmlInlineAtom(tag: string, attrs: Record<string, string>): {
  type: string;
  attrs: Record<string, unknown>;
} | null {
  const only = (names: string[]) => Object.keys(attrs).every((name) => names.includes(name));
  if (tag === 'br' && only(['data-nomo-break'])) {
    if (attrs['data-nomo-break'] && !['soft', 'hard'].includes(attrs['data-nomo-break'])) return null;
    return { type: 'hard_break', attrs: { soft: attrs['data-nomo-break'] === 'soft' } };
  }
  if (tag === 'img' && attrs.src !== undefined && only(['src', 'alt', 'title', 'width', 'align'])) {
    const src = attrs.src;
    if (/[\u0000-\u001f\u007f]/.test(src) || !(
      normalizeLinkHref(src) || /^(?:asset|tauri|file|blob):/i.test(src) ||
      /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,/i.test(src)
    )) return null;
    if (attrs.align && !['left', 'center', 'right'].includes(attrs.align)) return null;
    return { type: 'image', attrs: {
      src, alt: attrs.alt ?? null, title: attrs.title ?? null,
      width: attrs.width ?? null, align: attrs.align ?? null,
    } };
  }
  if (tag === 'span' && attrs.class === 'math-inline' && attrs['data-tex'] !== undefined &&
      only(['class', 'data-tex'])) {
    return { type: 'math_inline', attrs: { tex: attrs['data-tex'] } };
  }
  if (tag === 'span' && attrs.class === 'comment-inline' && attrs['data-comment'] !== undefined &&
      only(['class', 'data-comment'])) {
    return { type: 'comment_inline', attrs: { content: attrs['data-comment'] } };
  }
  if (tag === 'sup' && attrs.class === 'footnote-ref' && attrs['data-footnote-id'] !== undefined &&
      only(['class', 'data-footnote-id'])) {
    return { type: 'footnote_ref', attrs: { id: attrs['data-footnote-id'] } };
  }
  return null;
}

/**
 * 只把单个根元素、可表示的行内子树转成可编辑块。
 * 无法保真的结构和属性保留原文 fallback；此分类器也供 Worker 使用，不依赖 DOM。
 */
export function classifyHtmlBlock(rawHtml: string): HtmlBlockClassification {
  const html = rawHtml.trim();
  const root = readTag(html, 0);
  if (!root || root.closing || root.selfClosing || !EDITABLE_BLOCK_TAGS.has(root.tag)) {
    return { editable: false };
  }
  if (Object.keys(root.attrs).some((name) => name !== 'class' && name !== 'id')) {
    return { editable: false };
  }

  const stack: Array<{ tag: string; atom: boolean }> = [{ tag: root.tag, atom: false }];
  let offset = root.end;
  while (offset < html.length) {
    const start = html.indexOf('<', offset);
    if (start < 0) return { editable: false };
    const token = readTag(html, start);
    if (!token || DANGEROUS_TAGS.has(token.tag)) return { editable: false };
    if (token.closing) {
      if (stack.at(-1)?.tag !== token.tag) return { editable: false };
      stack.pop();
      if (!stack.length) {
        if (token.end !== html.length) return { editable: false };
        return { editable: true, tag: root.tag, innerHTML: html.slice(root.end, token.start), attrs: root.attrs };
      }
    } else {
      // 内层块、额外根元素、原子节点内的标签均无法用 html_block 的 inline* 表示。
      if (EDITABLE_BLOCK_TAGS.has(token.tag) || !EDITABLE_INLINE_TAGS.has(token.tag) ||
          stack.at(-1)?.atom || (token.tag === 'a' && stack.some((entry) => entry.tag === 'a'))) {
        return { editable: false };
      }
      const atom = readHtmlInlineAtom(token.tag, token.attrs);
      if (!atom && !isRepresentableInline(token.tag, token.attrs)) return { editable: false };
      const voidElement = token.tag === 'br' || token.tag === 'img';
      if (token.selfClosing && !voidElement) return { editable: false };
      if (!voidElement) stack.push({ tag: token.tag, atom: !!atom });
    }
    offset = token.end;
  }
  return { editable: false };
}

function isRepresentableInline(tag: string, attrs: Record<string, string>): boolean {
  if (tag === 'a') {
    if (Object.keys(attrs).some((name) => !['href', 'title', 'id', 'name'].includes(name))) return false;
    return createHtmlAnchorAttrs(attrs.href ?? null, attrs.title ?? null, attrs.id ?? null, attrs.name ?? null) !== null;
  }
  // span 无属性时只承载文字；带属性的 wrapper 不能无声扁平化。
  return tag !== 'img' && tag !== 'br' && Object.keys(attrs).length === 0;
}

/** 逐个消费属性，引号内的 >/< 不属于标签边界；重复属性遵循 HTML 的首个值语义。 */
export { readTag as readHtmlTag };

function readTag(html: string, start: number): HtmlTag | null {
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)(?:[^<>"']|"[^"]*"|'[^']*')*>/y;
  tagPattern.lastIndex = start;
  const match = tagPattern.exec(html);
  if (!match) return null;
  const raw = match[0];
  const tag = match[2].toLowerCase();
  const closing = match[1] === '/';
  if (closing) {
    if (!/^<\/[a-zA-Z][\w:-]*\s*>$/.test(raw)) return null;
    return { tag, start, end: tagPattern.lastIndex, closing, selfClosing: false, attrs: {} };
  }

  const attrs: Record<string, string> = Object.create(null);
  const attributePattern = /\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?/y;
  let cursor = 1 + match[2].length;
  while (cursor < raw.length) {
    if (/^\s*\/?\s*>$/.test(raw.slice(cursor))) {
      return { tag, start, end: tagPattern.lastIndex, closing, selfClosing: /\/\s*>$/.test(raw), attrs };
    }
    attributePattern.lastIndex = cursor;
    const attribute = attributePattern.exec(raw);
    if (!attribute) return null;
    const name = attribute[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) {
      attrs[name] = parseHtmlAttributes(attribute[0])[0]?.[1] ?? '';
    }
    cursor = attributePattern.lastIndex;
  }
  return null;
}

/** 从内联 HTML 开标签中提取真实属性，避免 data-id 和引号中的伪属性。 */
export function extractInlineAttrs(rawTag: string, tagName: string): Record<string, unknown> {
  const token = readTag(rawTag.trim(), 0);
  if (!token || token.closing || token.tag !== tagName.toLowerCase()) return {};
  const attrs: Record<string, unknown> = {};
  for (const name of ['class', 'id', 'href', 'title', 'name']) {
    if (token.attrs[name] !== undefined) attrs[name] = token.attrs[name];
  }
  return attrs;
}
