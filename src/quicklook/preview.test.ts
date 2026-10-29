import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyQuickLookAppearance,
  renderMarkdownPreview,
  renderQuickLookMermaidBlocks,
  resolvePreviewAssetSrc,
} from './preview';

afterEach(() => vi.restoreAllMocks());

describe('quicklook preview renderer', () => {
  it('renders markdown with callouts, task lists, tables and math', () => {
    const html = renderMarkdownPreview(
      [
        '# 标题',
        '',
        '> [!WARNING]',
        '> 请注意',
        '',
        '- [x] 完成',
        '- [ ] 待办',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '$E=mc^2$',
      ].join('\n'),
      { fileName: 'demo.md' },
    );

    expect(html).toContain('data-callout-type="warning"');
    expect(html).toContain('任务状态');
    expect(html).toContain('<table>');
    expect(html).toContain('katex');
  });

  it('renders custom callout titles and fold markers', () => {
    const html = renderMarkdownPreview(
      [
        '> [!SUCCESS]+ 已完成',
        '> 内容一',
        '',
        '> [!DANGER]-',
        '> 内容二',
        '',
        '> [!QUESTION]',
        '> 内容三',
      ].join('\n'),
      { fileName: 'demo.md' },
    );
    const dom = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const folded = dom.querySelectorAll('details.callout-card');
    expect(folded).toHaveLength(2);
    expect(folded[0].getAttribute('data-callout-type')).toBe('success');
    expect(folded[0].getAttribute('data-callout-fold')).toBe('open');
    expect(folded[0].hasAttribute('open')).toBe(true);
    expect(folded[0].querySelector('summary .callout-title')?.textContent).toBe('已完成');
    expect(folded[0].querySelector('.callout-body')?.textContent).toContain('内容一');
    expect(folded[1].getAttribute('data-callout-type')).toBe('danger');
    expect(folded[1].getAttribute('data-callout-fold')).toBe('closed');
    expect(folded[1].hasAttribute('open')).toBe(false);
    expect(folded[1].querySelector('summary .callout-title')?.textContent).toBe('危险');
    expect(folded[1].querySelector('.callout-body')?.textContent).toContain('内容二');
    const question = dom.querySelector('div.callout-card[data-callout-type="question"]');
    expect(question?.querySelector('.callout-title')?.textContent).toBe('问题');
  });

  it('renders bare URLs and emails as safe links', () => {
    const html = renderMarkdownPreview(
      '访问 https://example.com/a_b 或 a@b.com',
      { fileName: 'demo.md' },
    );

    expect(html).toContain('href="https://example.com/a_b"');
    expect(html).toContain('>https://example.com/a_b</a>');
    expect(html).toContain('href="mailto:a@b.com"');
    expect(html).toContain('>a@b.com</a>');
  });

  it('renders Mermaid fences to themed SVG diagrams', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownPreview(
      '```mermaid\nflowchart TB\n  A["项目台账"] --> B["项目验收"]\n```',
    );
    const renderMermaid = vi.fn(async () => ({
      svg: '<svg viewBox="0 0 100 40" data-diagram="ready"></svg>',
    }));

    const bindings = await renderQuickLookMermaidBlocks(root, { theme: 'dark' }, { renderMermaid });

    expect(renderMermaid).toHaveBeenCalledWith('flowchart TB\n  A["项目台账"] --> B["项目验收"]', {
      theme: { theme: 'dark' },
    });
    expect(root.querySelector('.mermaid-block')?.classList.contains('is-rendered')).toBe(true);
    expect(root.querySelector('.mermaid-block-rendered svg')?.getAttribute('data-diagram')).toBe(
      'ready',
    );
    expect(bindings).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('.mermaid-block-fullscreen-button')?.click();
    expect(document.body.querySelector('.mermaid-fullscreen-overlay')).not.toBeNull();
    expect(document.body.querySelector('.mermaid-fullscreen-zoom-badge')?.textContent).toBe('100%');
    document.body
      .querySelector<HTMLButtonElement>('.mermaid-fullscreen-control-button:last-child')
      ?.click();
    expect(document.body.querySelector('.mermaid-fullscreen-zoom-badge')?.textContent).toBe('110%');
    bindings[0]?.dispose();
    expect(document.body.querySelector('.mermaid-fullscreen-overlay')).toBeNull();
  });

  it('keeps Mermaid source visible when diagram rendering fails', async () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownPreview('```mermaid\nnot-a-diagram\n```');

    await renderQuickLookMermaidBlocks(
      root,
      { theme: 'default' },
      {
        async renderMermaid() {
          throw new Error('UnknownDiagramError');
        },
      },
    );

    expect(root.querySelector('.mermaid-block')?.classList.contains('is-error')).toBe(true);
    expect(root.querySelector('.mermaid-block-rendered')?.textContent).toContain(
      'UnknownDiagramError',
    );
    expect(root.querySelector('.mermaid-block-source')?.textContent).toContain('not-a-diagram');
  });

  it('blocks dangerous links and script html', () => {
    const html = renderMarkdownPreview(
      '[bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<a onclick="evil()" href="https://example.com">ok</a>',
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('https://example.com');
  });

  it('resolves relative image paths against the markdown directory', () => {
    const html = renderMarkdownPreview('![图](<assets/a b.png>){width=240}', {
      documentDirectory: '/Users/qingyu/Notes',
    });

    expect(html).toContain('file:///Users/qingyu/Notes/assets/a%20b.png');
    expect(html).toContain('width="240"');
  });

  it('marks shields badges so they keep GitHub-like inline sizing', () => {
    const html = renderMarkdownPreview(
      '![Release](https://img.shields.io/github/v/release/LIXianSenQwQ/nomo?label=release)',
    );

    expect(html).toContain('class="image-badge"');
  });

  it('does not allow data image sources', () => {
    const html = renderMarkdownPreview('![x](data:image/svg+xml,<svg></svg>)');

    expect(html).toContain('image-node-placeholder');
    expect(html).not.toContain('data:image');
  });

  it('converts absolute paths to file urls', () => {
    expect(resolvePreviewAssetSrc('/Users/qingyu/Pictures/a.png')).toBe(
      'file:///Users/qingyu/Pictures/a.png',
    );
  });

  it('applies the same registered appearance tokens as the main app', () => {
    const root = document.createElement('div');

    const resolved = applyQuickLookAppearance(
      {
        themeMode: 'dark',
        colorThemeId: 'nomo-github',
        documentStyleId: 'nomo-modern',
      },
      root,
    );

    expect(resolved?.effectiveScheme).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.colorTheme).toBe('nomo-github');
    expect(root.dataset.documentStyle).toBe('nomo-modern');
    expect(resolved.tokens.documentBackground).toBe('#0D1117');
    expect(root.style.getPropertyValue('--md-editor-document-bg')).toBe('#0D1117');
  });
});
