/**
 * HTML5 / CSS3 补全上下文识别与候选词表。
 *
 * 纯函数、不依赖 CodeMirror 或 DOM，便于单独测试；
 * 只在明确属于 HTML 标签、属性和 CSS 声明的位置返回候选，
 * 普通 Markdown 正文中输入的 `<` 或 `:` 不会被打扰。
 */

export type CompletionKind = 'tag' | 'attribute' | 'css-property' | 'css-value';

export interface CompletionItem {
  label: string;
  detail: string;
}

export interface CompletionRequest {
  kind: CompletionKind;
  /** 需要被替换的文档区间；`to` 始终等于光标位置。 */
  from: number;
  to: number;
  prefix: string;
  items: CompletionItem[];
}

export const HTML_TAGS = [
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd',
  'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav',
  'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small',
  'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul',
  'var', 'video', 'wbr',
] as const;

export const HTML_ATTRIBUTES = [
  'accept', 'accept-charset', 'accesskey', 'action', 'align', 'allow', 'alt', 'aria-hidden',
  'aria-label', 'aria-labelledby', 'aria-describedby', 'async', 'autocomplete', 'autofocus',
  'autoplay', 'charset', 'checked', 'cite', 'class', 'cols', 'colspan', 'content',
  'contenteditable', 'controls', 'coords', 'crossorigin', 'datetime', 'decoding', 'default',
  'defer', 'dir', 'disabled', 'download', 'draggable', 'enctype', 'for', 'form', 'headers',
  'height', 'hidden', 'href', 'hreflang', 'id', 'integrity', 'lang', 'loading', 'loop', 'max',
  'maxlength', 'media', 'method', 'min', 'minlength', 'multiple', 'muted', 'name', 'novalidate',
  'open', 'pattern', 'placeholder', 'poster', 'preload', 'readonly', 'rel', 'required',
  'reversed', 'role', 'rows', 'rowspan', 'scope', 'selected', 'sizes', 'slot', 'span', 'src',
  'srcset', 'start', 'step', 'style', 'tabindex', 'target', 'title', 'translate', 'type',
  'usemap', 'value', 'width',
] as const;

export const CSS_PROPERTIES = [
  'align-content', 'align-items', 'align-self', 'animation', 'aspect-ratio', 'backface-visibility',
  'background', 'background-color', 'background-image', 'background-position',
  'background-repeat', 'background-size', 'border', 'border-bottom', 'border-collapse',
  'border-color', 'border-left', 'border-radius', 'border-right', 'border-style', 'border-top',
  'border-width', 'bottom', 'box-shadow', 'box-sizing', 'color', 'column-count', 'column-gap',
  'content', 'cursor', 'display', 'filter', 'flex', 'flex-basis', 'flex-direction', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'float', 'font', 'font-family', 'font-size', 'font-style',
  'font-variant', 'font-weight', 'gap', 'grid', 'grid-area', 'grid-column', 'grid-row',
  'grid-template-areas', 'grid-template-columns', 'grid-template-rows', 'height',
  'justify-content', 'left', 'letter-spacing', 'line-height', 'list-style', 'list-style-type',
  'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'object-fit', 'opacity', 'order', 'outline',
  'overflow', 'overflow-wrap', 'padding', 'padding-bottom', 'padding-left', 'padding-right',
  'padding-top', 'position', 'right', 'row-gap', 'text-align', 'text-decoration',
  'text-indent', 'text-overflow', 'text-shadow', 'text-transform', 'top', 'transform',
  'transition', 'user-select', 'vertical-align', 'visibility', 'white-space', 'width',
  'word-break', 'word-spacing', 'z-index',
] as const;

const CSS_VALUES: Record<string, readonly string[]> = {
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents', 'table', 'table-cell'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  'text-align': ['left', 'center', 'right', 'justify', 'start', 'end'],
  'font-weight': ['normal', 'bold', 'lighter', 'bolder', '400', '500', '600', '700', '900'],
  'font-style': ['normal', 'italic', 'oblique'],
  'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'text-decoration': ['none', 'underline', 'line-through', 'overline'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  overflow: ['visible', 'hidden', 'scroll', 'auto', 'clip'],
  'overflow-wrap': ['normal', 'break-word', 'anywhere'],
  'box-sizing': ['content-box', 'border-box'],
  cursor: ['pointer', 'default', 'text', 'move', 'grab', 'grabbing', 'not-allowed', 'wait', 'help'],
  'border-style': ['none', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'],
  visibility: ['visible', 'hidden', 'collapse'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
  'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
  'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  'align-items': ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  'align-self': ['auto', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
  float: ['left', 'right', 'none'],
  'object-fit': ['fill', 'contain', 'cover', 'none', 'scale-down'],
  color: ['inherit', 'currentColor', 'transparent', 'black', 'white', 'red', 'blue', 'green', 'gray'],
  'list-style-type': ['disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'none'],
};

const MAX_ITEMS = 50;
const MAX_SCAN_CHARS = 200_000;
const MAX_SCAN_LINES = 2_000;

/** 编辑器只把光标前这么长的文本交给补全识别，避免大文档每次按键全量复制。 */
export const COMPLETION_SCAN_WINDOW = MAX_SCAN_CHARS;

/** 识别光标处的补全请求；不在可补全位置时返回 null。 */
export function detectHtmlCssCompletion(text: string, position: number): CompletionRequest | null {
  const cursor = Math.max(0, Math.min(position, text.length));
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  const lineEnd = text.indexOf('\n', cursor);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const before = line.slice(0, cursor - lineStart);
  const fence = findFenceLanguage(text, cursor);

  const htmlFence = fence && ['html', 'htm', 'xhtml', 'xml', 'svg'].includes(fence.language);
  if (fence && fence.language !== 'css' && !htmlFence) return null;
  if (!fence && hasUnclosedInlineCode(before)) return null;

  if (fence?.language === 'css') return detectCssInBlock(text, cursor, fence.contentStart);

  if (!fence || htmlFence) {
    const styleElementStart = findOpenStyleElement(text, cursor);
    if (styleElementStart !== null) return detectCssInBlock(text, cursor, styleElementStart);
  }

  const styleAttribute = findStyleAttribute(before);
  if (styleAttribute) {
    return detectCssDeclaration(before.slice(styleAttribute.contentStart), cursor);
  }

  return detectHtmlTag(before, cursor);
}

interface FenceState {
  language: string;
  contentStart: number;
}

/** 光标前最近的围栏行决定代码语言；只在有语言的开始行之后才生效。 */
function findFenceLanguage(text: string, position: number): FenceState | null {
  let lineStart = text.lastIndexOf('\n', position - 1) + 1;
  let scanned = 0;
  const earliest = Math.max(0, position - MAX_SCAN_CHARS);
  while (lineStart > earliest && scanned < MAX_SCAN_LINES) {
    const previousEnd = lineStart > 0 ? lineStart - 1 : 0;
    const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1;
    const line = text.slice(previousStart, previousEnd);
    const match = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (match) {
      const language = (match[2] ?? '').toLowerCase();
      if (!language) return null;
      return { language, contentStart: previousEnd + 1 };
    }
    if (previousStart === 0) break;
    lineStart = previousStart;
    scanned += 1;
  }
  return null;
}

function hasUnclosedInlineCode(before: string): boolean {
  let count = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== '`') continue;
    if (before[index - 1] === '\\') continue;
    count += 1;
  }
  return count % 2 === 1;
}

interface StyleAttribute {
  contentStart: number;
}

/** 当前行 `style="…"` 内的 CSS；内容起点是引号之后。 */
function findStyleAttribute(before: string): StyleAttribute | null {
  const match = /style\s*=\s*(["'])/gi;
  let last: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((last = match.exec(before))) {
    const quote = last[1];
    const rest = before.slice(last.index + last[0].length);
    if (!rest.includes(quote)) {
      lastMatch = last;
      break;
    }
  }
  if (!lastMatch) return null;
  return { contentStart: lastMatch.index + lastMatch[0].length };
}

/** 最近一个尚未闭合的 `<style>` 内容起点。 */
function findOpenStyleElement(text: string, position: number): number | null {
  const windowStart = Math.max(0, position - MAX_SCAN_CHARS);
  const fragment = text.slice(windowStart, position);
  const open = /<style\b[^>]*>/gi;
  let lastOpen: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = open.exec(fragment))) lastOpen = match;
  if (!lastOpen) return null;
  const close = /<\/style\s*>/gi;
  close.lastIndex = lastOpen.index + lastOpen[0].length;
  let lastClose: RegExpExecArray | null = null;
  while ((match = close.exec(fragment))) lastClose = match;
  if (lastClose) return null;
  return windowStart + lastOpen.index + lastOpen[0].length;
}

function detectCssInBlock(text: string, position: number, contentStart: number): CompletionRequest | null {
  const slice = text.slice(contentStart, position);
  const lastOpen = slice.lastIndexOf('{');
  const lastClose = slice.lastIndexOf('}');
  // 还没有进入声明块（或已经离开）时处在选择器位置，不提示属性。
  if (lastOpen < lastClose) return null;
  return detectCssDeclaration(slice, position);
}

/**
 * 解析一条 CSS 声明。`content` 是声明块（或 style 属性）开头到光标的文本；
 * 以最后一个 `{` / `}` / `;` 为界，前半段是属性名，冒号之后是属性值。
 */
function detectCssDeclaration(content: string, position: number): CompletionRequest | null {
  // 去掉注释，避免把注释里的冒号当成属性分隔符。
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const boundary = Math.max(
    withoutComments.lastIndexOf(';'),
    withoutComments.lastIndexOf('{'),
    withoutComments.lastIndexOf('}'),
    withoutComments.lastIndexOf('\n'),
  );
  const segment = content.slice(Math.max(boundary + 1, 0));
  const colon = segment.indexOf(':');

  if (colon < 0) {
    const prefix = segment.replace(/^\s+/, '');
    if (!/^[-\w]*$/.test(prefix)) return null;
    return buildRequest('css-property', position - prefix.length, position, prefix,
      CSS_PROPERTIES.map((label) => ({ label, detail: 'CSS 属性' })));
  }

  const property = segment.slice(0, colon).trim().toLowerCase();
  if (!/^[-\w]+$/.test(property)) return null;
  const rawValue = segment.slice(colon + 1);
  const prefix = rawValue.replace(/^\s+/, '');
  if (!/^[-\w%#.,()\s]*$/.test(prefix)) return null;
  const values = CSS_VALUES[property];
  if (!values) return null;
  return buildRequest('css-value', position - prefix.length, position, prefix,
    values.map((label) => ({ label, detail: property })));
}

function detectHtmlTag(before: string, position: number): CompletionRequest | null {
  const openIndex = before.lastIndexOf('<');
  if (openIndex < 0) return null;
  if (before.lastIndexOf('>') > openIndex) return null;
  const tagText = before.slice(openIndex + 1);
  // 注释、DOCTYPE 和处理指令没有可补全的标签名；`/` 开头的闭合标签仍要提示。
  if (/^[!?]/.test(tagText)) return null;

  const quotes = (tagText.match(/["']/g) ?? []).length;
  if (quotes % 2 === 1) return null;

  if (/^\/?[\w-]*$/.test(tagText)) {
    const prefix = tagText.replace(/^\//, '');
    return buildRequest('tag', position - prefix.length, position, prefix,
      HTML_TAGS.map((label) => ({ label, detail: 'HTML 标签' })));
  }

  if (!/^\s*[\w-]+\s/.test(tagText)) return null;
  if (/=\s*$/.test(tagText)) return null;
  const attributeMatch = /(?:^|\s)([^\s=<>"'/]*)$/.exec(tagText);
  if (!attributeMatch) return null;
  const prefix = attributeMatch[1];
  if (!/^[\w:-]*$/.test(prefix)) return null;
  return buildRequest('attribute', position - prefix.length, position, prefix,
    HTML_ATTRIBUTES.map((label) => ({ label, detail: 'HTML 属性' })));
}

function buildRequest(
  kind: CompletionKind,
  from: number,
  to: number,
  prefix: string,
  candidates: CompletionItem[],
): CompletionRequest | null {
  const lower = prefix.toLowerCase();
  const items = candidates
    .filter((item) => item.label.toLowerCase().startsWith(lower))
    .slice(0, MAX_ITEMS);
  if (items.length === 0) return null;
  // 已经完整输入唯一候选时不再弹出（避免接受后原地反复提示）。
  if (items.length === 1 && items[0].label.toLowerCase() === lower) return null;
  return { kind, from, to, prefix, items };
}
