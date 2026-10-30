/**
 * PDF 排版选项：纸张、页边距、页眉页脚模板与分页规则。
 *
 * 本模块只处理与渲染无关的 HTML 变换，供导出服务与设置界面共用；
 * 真正的分页由原生打印完成，页眉页脚由 Rust 后处理绘制。
 */

export type PdfPaperSize = 'A4' | 'A3' | 'A5' | 'B5' | 'Letter' | 'Legal';
export type PdfOrientation = 'portrait' | 'landscape';

export interface PdfMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PdfLayout {
  paperSize: PdfPaperSize;
  orientation: PdfOrientation;
  margins: PdfMargins;
  /** 页眉模板，空字符串表示不绘制页眉。 */
  headerTemplate: string;
  /** 页脚模板，空字符串表示不绘制页脚。 */
  footerTemplate: string;
  /** 是否在每个一级标题前分页。 */
  pageBreakBeforeH1: boolean;
}

export interface PdfChromeMeta {
  title: string;
  date: string;
}

/** 手动分页符在 Markdown 中的写法；导出时会被替换为分页元素。 */
export const PAGE_BREAK_MARKER = '<div class="nomo-page-break"></div>';
export const PAGE_BREAK_COMMENT_PATTERN = /^nomo:page-break$/;

export const PAGE_BREAK_CLASS = 'nomo-page-break';
const H1_BREAK_CLASS = 'nomo-page-break-before';
export const PDF_LAYOUT_MAX_TEMPLATE_LENGTH = 240;

export const DEFAULT_PDF_LAYOUT: PdfLayout = {
  paperSize: 'A4',
  orientation: 'portrait',
  margins: { top: 20, right: 20, bottom: 20, left: 20 },
  headerTemplate: '',
  footerTemplate: '{page} / {total}',
  pageBreakBeforeH1: false,
};

export const PDF_PAPER_SIZES: readonly PdfPaperSize[] = ['A4', 'A3', 'A5', 'B5', 'Letter', 'Legal'];

/**
 * 将排版选项落到导出 HTML 上：替换手动分页符，并注入打印分页样式。
 *
 * 返回新字符串，不修改入参；找不到正文容器时原样返回。
 */
export function applyPdfLayout(html: string, layout: PdfLayout): string {
  if (typeof DOMParser === 'undefined') {
    return html;
  }
  const parser = new DOMParser();
  const document = parser.parseFromString(html, 'text/html');
  const article = document.querySelector('.nomo-export') ?? document.body;
  if (!article) {
    return html;
  }

  const comments: Comment[] = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Comment;
    if (PAGE_BREAK_COMMENT_PATTERN.test(node.data.trim())) {
      comments.push(node);
    }
  }
  for (const comment of comments) {
    replacePageBreakComment(document, comment);
  }
  // 编辑器中插入的分页符本身就是 HTML 块，直接补上分页语义所需的祖先结构。
  article.querySelectorAll(`.${PAGE_BREAK_CLASS}`).forEach((element) => {
    if (element.parentElement?.tagName === 'P' && element.textContent?.trim() === '') {
      element.parentElement.replaceWith(element);
    }
  });

  if (layout.pageBreakBeforeH1) {
    markHeadingPageBreaks(article);
  }

  const style = document.createElement('style');
  style.textContent = buildPdfLayoutStyles();
  document.head.append(style);

  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
}

/** 原生打印只接受固定占位符；未知占位符原样保留。 */
export function buildPdfChromePayload(layout: PdfLayout, meta: PdfChromeMeta) {
  return {
    header_template: layout.headerTemplate,
    footer_template: layout.footerTemplate,
    title: meta.title,
    date: meta.date,
  };
}

function buildPdfLayoutStyles(): string {
  return `
.${PAGE_BREAK_CLASS} {
  height: 0;
  margin: 0;
  border: 0;
  overflow: hidden;
  break-after: page;
  page-break-after: always;
}
.${H1_BREAK_CLASS} {
  break-before: page;
  page-break-before: always;
}
`;
}

function markHeadingPageBreaks(article: Element): void {
  const headings = Array.from(article.querySelectorAll('h1'));
  for (const heading of headings) {
    if (isFirstContentElement(article, heading)) {
      continue;
    }
    heading.classList.add(H1_BREAK_CLASS);
  }
}

/** 文档开头的一级标题不分页，否则会多出一张空白页。 */
function isFirstContentElement(article: Element, heading: Element): boolean {
  let node: Element | null = heading;
  while (node && node !== article) {
    if (node.previousElementSibling) {
      return false;
    }
    node = node.parentElement;
    if (node === article) {
      return true;
    }
  }
  return true;
}

function replacePageBreakComment(document: Document, comment: Comment): void {
  const breakElement = document.createElement('div');
  breakElement.className = PAGE_BREAK_CLASS;
  breakElement.setAttribute('aria-hidden', 'true');

  const parent = comment.parentNode;
  if (!parent) {
    return;
  }

  if (isParagraph(parent) && isOnlyChildComment(parent, comment)) {
    parent.replaceWith(breakElement);
    return;
  }

  if (isParagraph(parent)) {
    const before = document.createElement('p');
    const after = document.createElement('p');
    moveSiblings(parent, comment, before, after);
    const replacement: Node[] = [];
    if (before.childNodes.length > 0) replacement.push(before);
    replacement.push(breakElement);
    if (after.childNodes.length > 0) replacement.push(after);
    parent.replaceWith(...replacement);
    return;
  }

  parent.replaceChild(breakElement, comment);
}

function isParagraph(node: Node): node is HTMLElement {
  return node.nodeType === 1 && (node as Element).tagName === 'P';
}

function isOnlyChildComment(parent: Node, comment: Comment): boolean {
  for (const child of Array.from(parent.childNodes)) {
    if (child === comment) continue;
    if (child.nodeType === 3 && String(child.textContent).trim() === '') continue;
    return false;
  }
  return true;
}

function moveSiblings(parent: Node, comment: Comment, before: HTMLElement, after: HTMLElement): void {
  let node = comment.previousSibling;
  while (node) {
    const previous = node.previousSibling;
    before.prepend(node);
    node = previous;
  }
  node = comment.nextSibling;
  while (node) {
    const next = node.nextSibling;
    after.append(node);
    node = next;
  }
  parent.removeChild(comment);
}
