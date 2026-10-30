import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PDF_LAYOUT,
  PAGE_BREAK_MARKER,
  applyPdfLayout,
  buildPdfChromePayload,
  type PdfLayout,
} from './pdfLayout';

const layout = (overrides: Partial<PdfLayout> = {}): PdfLayout => ({
  ...DEFAULT_PDF_LAYOUT,
  ...overrides,
});

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const page = (body: string) =>
  `<!DOCTYPE html><html><head></head><body><article class="nomo-export markdown-body">${body}</article></body></html>`;

describe('PDF layout', () => {
  it('把 HTML 块分页符保留为分页元素并注入分页样式', () => {
    const html = applyPdfLayout(page(`<p>前</p>${PAGE_BREAK_MARKER}<p>后</p>`), layout());
    const doc = parse(html);
    expect(doc.querySelectorAll('.nomo-page-break')).toHaveLength(1);
    expect(doc.querySelector('.nomo-page-break')?.tagName).toBe('DIV');
    expect(doc.querySelector('style')?.textContent).toContain('break-after: page');
  });

  it('兼容注释写法，并把夹在段落中间的分页符拆成独立块', () => {
    const html = applyPdfLayout(page('<p>前<!-- nomo:page-break -->后</p>'), layout());
    const doc = parse(html);
    const paragraphs = [...doc.querySelectorAll('p')];
    expect(paragraphs.map((item) => item.textContent)).toEqual(['前', '后']);
    const breakElement = doc.querySelector('.nomo-page-break');
    expect(breakElement?.previousElementSibling?.textContent).toBe('前');
    expect(breakElement?.nextElementSibling?.textContent).toBe('后');
  });

  it('整段只有分页符注释时替换整段，不留下空段落', () => {
    const html = applyPdfLayout(page('<p><!-- nomo:page-break --></p>\n<p>正文</p>'), layout());
    const doc = parse(html);
    expect(doc.querySelectorAll('p')).toHaveLength(1);
    expect(doc.querySelector('.nomo-page-break')).not.toBeNull();
  });

  it('一级标题前分页时跳过文档开头的标题', () => {
    const html = applyPdfLayout(
      page('<h1>标题一</h1><p>正文</p><h1>标题二</h1><h2>二级</h2><h1>标题三</h1>'),
      layout({ pageBreakBeforeH1: true }),
    );
    const doc = parse(html);
    const headings = [...doc.querySelectorAll('h1')];
    expect(headings.map((heading) => heading.classList.contains('nomo-page-break-before'))).toEqual([
      false,
      true,
      true,
    ]);
    expect(doc.querySelector('style')?.textContent).toContain('break-before: page');
  });

  it('关闭一级标题分页时不添加类名', () => {
    const html = applyPdfLayout(page('<h1>一</h1><h1>二</h1>'), layout({ pageBreakBeforeH1: false }));
    expect(parse(html).querySelectorAll('.nomo-page-break-before')).toHaveLength(0);
  });

  it('生成原生打印使用的页眉页脚参数', () => {
    expect(
      buildPdfChromePayload(layout({ headerTemplate: '{title}', footerTemplate: '{page}/{total}' }), {
        title: '文档',
        date: '2026-10-30',
      }),
    ).toEqual({
      header_template: '{title}',
      footer_template: '{page}/{total}',
      title: '文档',
      date: '2026-10-30',
    });
  });
});
