import { describe, expect, it, vi } from 'vitest';
import { renderExportBody } from './render';
import { captureExportAppearance } from './snapshot';
import type { ExportSnapshot } from './types';

const tokenize = vi.hoisted(() => vi.fn(async (input: { code: string }) => ({ tokens: input.code.split('\n').map(content => ({ tokens: [{ content, color: '#abc123', fontStyle: '2' }] })) })));
vi.mock('../../../lib/services/shikiCodeTokenizer', () => ({ createShikiCodeTokenizer: () => ({ tokenize }) }));
vi.mock('../../../lib/services/mermaidDiagramRenderer', () => ({ createMermaidDiagramRenderer: () => ({
  renderMermaid: vi.fn(async (code: string) => code === 'BAD' ? { svg: '', error: 'invalid diagram' } : { svg: '<svg viewBox="0 0 20 20"><text>diagram</text></svg>' }),
}) }));

function snapshot(markdown: string): ExportSnapshot {
  return { documentId: 'a', contentRevision: 1, markdown, documentPath: null, title: 'a', suggestedFileName: 'a', appearance: captureExportAppearance() };
}

describe('unmounted readonly export', () => {
  it('renders nested details with saved defaults and complete code/image content', async () => {
    const source = '<details>\n<summary><strong>标题</strong></summary>\n\n```js\nconst a = 1\n```\n\n![pic](./a.png)\n\n<details open>\n<summary>内层</summary>\n\n完整正文\n\n</details>\n\n</details>';
    const result = await renderExportBody(snapshot(source));
    const dom = new DOMParser().parseFromString(result.html, 'text/html');
    expect(dom.querySelectorAll('details')).toHaveLength(2);
    expect(dom.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(dom.querySelector('details details')?.hasAttribute('open')).toBe(true);
    expect(dom.querySelector('summary strong')?.textContent).toBe('标题');
    expect(dom.querySelector('details .code-card')?.textContent).toContain('const a = 1');
    expect(dom.querySelector('details img')?.getAttribute('src')).toBe('./a.png');
    expect(dom.body.textContent).toContain('完整正文');
    expect(result.warnings).toEqual([]);
  });
  it('README HTML 的徽章与语言链接沿用编辑器的行内排版，内嵌前标记回退 HTML 图片', async () => {
    const input = snapshot([
      '<p align="center">\n  <a href="https://example.com/release">\n    <img src="https://img.shields.io/github/v/release/nomo-md/nomo" alt="release">\n  </a>\n  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="platform">\n  <a href="./LICENSE">\n    <img src="https://badgen.net/badge/license/AGPL" alt="license">\n  </a>\n</p>',
      '<p align="center">\n  <a href="./README.md"><strong>简体中文</strong></a>\n  ·\n  <a href="./README.en.md">English</a>\n</p>',
      '<p align="right">第一行<br>第二行</p>',
    ].join('\n\n'));
    const result = await renderExportBody(input);
    const dom = new DOMParser().parseFromString(result.html, 'text/html');
    const rows = dom.querySelectorAll<HTMLElement>('.html-widget-aligned-paragraph');
    expect(rows).toHaveLength(3);
    expect([...rows].map(row => row.style.whiteSpace)).toEqual(['normal', 'normal', 'normal']);
    expect(rows[0].style.textAlign).toBe('center');
    expect(rows[0].querySelectorAll('img[data-nomo-badge]')).toHaveLength(3);
    expect(rows[0].querySelectorAll('a > img[data-nomo-badge]')).toHaveLength(2);
    expect(rows[1].querySelector('p')).toBeNull();
    expect(rows[1].textContent?.replace(/\s+/g, ' ').trim()).toBe('简体中文 · English');
    expect(rows[2].style.textAlign).toBe('right');
    expect(rows[2].querySelectorAll('br')).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('无编辑器视图也能输出代码、公式、图表、目录、Callout 和任务状态', async () => {
    const input = snapshot('# 标题\n\n<!-- toc -->\n<!-- /toc -->\n\n> [!TIP]\n> **建议**\n\n- [x] 完成\n\n```js\nconst x = 1;\n\nconsole.log(x);\n```\n\n$$x^2$$\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n脚注[^a]\n\n[^a]: 说明');
    const result = await renderExportBody(input);
    const dom = new DOMParser().parseFromString(result.html, 'text/html');
    expect(dom.querySelector('.callout-header .callout-icon svg')).not.toBeNull();
    expect(dom.querySelector('.callout-body strong')?.textContent).toBe('建议');
    expect(dom.querySelector('input[checked][disabled]')).not.toBeNull();
    expect(dom.querySelectorAll('.code-line')).toHaveLength(3);
    expect(dom.querySelector('.export-code code')?.textContent).toBe('const x = 1;\n\nconsole.log(x);');
    expect(tokenize).toHaveBeenCalledWith(expect.objectContaining({ theme: input.appearance.shikiTheme }));
    expect(dom.querySelector('.katex')).not.toBeNull();
    expect(dom.querySelector('.mermaid-block svg')).not.toBeNull();
    const toc = dom.querySelector<HTMLAnchorElement>('.toc-link');
    expect(toc?.getAttribute('href')).toBe(`#${encodeURIComponent(dom.querySelector('h1')!.id)}`);
    expect(dom.querySelector('.footnote-ref a')?.getAttribute('href')).toContain('nomo-fn-a');
    expect(dom.querySelector('#nomo-fn-a')).not.toBeNull();
    expect(dom.querySelector('[contenteditable],button,textarea')).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('保留图片对齐、尺寸以及表格合并单元格；图表失败显示原文与错误', async () => {
    const input = snapshot('<p align="right"><img src="blob:pic" width="240"></p>\n\n<table><tr><th colspan="2">表头</th></tr><tr><td>A</td><td>B</td></tr></table>\n\n```mermaid\nBAD\n```');
    const result = await renderExportBody(input);
    const dom = new DOMParser().parseFromString(result.html, 'text/html');
    expect(dom.querySelector('img')?.style.width).toBe('240px');
    expect(dom.querySelector('img')?.style.marginLeft).toBe('auto');
    expect(dom.querySelector('th')?.colSpan).toBe(2);
    expect(dom.querySelector('.nomo-export-source')?.textContent).toBe('BAD');
    expect(dom.querySelector('.nomo-render-error')?.textContent).toContain('invalid diagram');
    expect(result.warnings).toHaveLength(1);
  });
});
