import { DANGEROUS_TAGS, EDITABLE_BLOCK_TAGS, EDITABLE_INLINE_TAGS } from '../html/htmlPolicy';
import { normalizeLinkHref } from '../link';

const FALLBACK_TAGS: ReadonlySet<string> = new Set([
  ...EDITABLE_BLOCK_TAGS,
  ...EDITABLE_INLINE_TAGS,
  'p', 'br', 'hr', 'b', 'i', 'mark', 'small', 'sub', 'sup', 'kbd', 'samp', 'var', 'abbr',
  'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'img',
]);
const FALLBACK_COMMON_ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'id', 'title', 'lang', 'dir']);
const FALLBACK_TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'name'],
  p: ['align'],
  h1: ['align'],
  h2: ['align'],
  h3: ['align'],
  h4: ['align'],
  h5: ['align'],
  h6: ['align'],
  table: ['border', 'cellpadding', 'cellspacing', 'width', 'align'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  th: ['colspan', 'rowspan', 'scope', 'headers', 'align', 'valign', 'width', 'height'],
  td: ['colspan', 'rowspan', 'headers', 'align', 'valign', 'width', 'height'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  img: ['src', 'alt', 'width', 'height'],
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 仅展示允许的静态 HTML；不能安全表示的结构保留为字面原文。 */
export function sanitizeHtml(html: string): string {
  if (typeof document === 'undefined') return escapeHtml(html);

  // template 的内容在独立文档中解析，校验前不会加载资源或激活节点。
  const template = document.createElement('template');
  template.innerHTML = html;
  const pendingNodes = Array.from(template.content.childNodes);
  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop()!;
    if (node.nodeType === 3) continue;
    if (node.nodeType === 8) {
      node.remove();
      continue;
    }
    if (node.nodeType !== 1) return escapeHtml(html);

    const element = node as Element;
    const tag = element.localName;
    // is 的内部值可能在序列化时重新出现，不能只靠删除属性阻止自定义元素。
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.hasAttribute('is') ||
        DANGEROUS_TAGS.has(tag) || !FALLBACK_TAGS.has(tag)) {
      return escapeHtml(html);
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name;
      // 属性按标签放行，style、事件、srcdoc、ping 等不能进入最终 widget。
      if (attribute.namespaceURI !== null ||
          (!FALLBACK_COMMON_ATTRIBUTES.has(name) && !FALLBACK_TAG_ATTRIBUTES[tag]?.includes(name))) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (name === 'href' || name === 'src') {
        // DOM 已解码字符实体，再复用 Markdown 链接的协议和控制字符边界。
        const href = normalizeLinkHref(attribute.value);
        if (href) element.setAttribute(name, href);
        else element.removeAttributeNode(attribute);
      }
    }
    for (const child of Array.from(element.childNodes)) pendingNodes.push(child);
  }
  return template.innerHTML;
}

/** 编辑器与导出共用 HTML 回退展示；源码缩进不能变成居中段落里的视觉换行。 */
export function renderHtmlPreview(target: HTMLElement, safeHtml: string): void {
  const template = document.createElement('template');
  template.innerHTML = safeHtml.trim();
  const children = Array.from(template.content.childNodes).filter(
    node => node.nodeType !== Node.TEXT_NODE || node.textContent?.trim(),
  );
  const root = children.length === 1 && children[0].nodeType === Node.ELEMENT_NODE
    ? children[0] as HTMLElement : null;

  if (root?.localName === 'p') {
    const align = root.getAttribute('align')?.toLowerCase();
    if (align === 'left' || align === 'center' || align === 'right') {
      target.classList.add('html-widget-aligned-paragraph');
      target.style.display = 'block';
      target.style.textAlign = align;
      target.style.whiteSpace = 'normal';
    }
    target.innerHTML = root.innerHTML;
    return;
  }
  target.innerHTML = safeHtml;
}
