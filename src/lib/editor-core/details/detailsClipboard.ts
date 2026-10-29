import { isDetailsHtmlBody, readDetailsSource } from './detailsSyntax';

/** 无法完整表示的剪贴板容器退回原文，避免 DOMParser 静默丢掉标题图片或未知属性。 */
export function preserveUnsupportedDetailsHtml(html: string): string {
  if (!/<details(?:\s|>)/i.test(html)) return html;
  const root = document.createElement('div');
  root.innerHTML = html;
  for (const element of Array.from(root.querySelectorAll('details'))) {
    if (element.parentElement?.closest('details')) continue;
    const source = element.outerHTML;
    const parsed = readDetailsSource(source);
    if (parsed && isDetailsHtmlBody(`<div data-nomo-details-body>${parsed.body}</div>`)) continue;
    const fallback = document.createElement('p');
    fallback.textContent = source;
    element.replaceWith(fallback);
  }
  return root.innerHTML;
}
