import { describe, expect, it } from 'vitest';
import {
  isDocxMarkdownSource,
  prepareDocxPreviewMarkdown,
} from './previewMarkdown';
import { renderPreview } from './renderPreview';

const SOURCE = [
  '<!-- section | start: nextPage -->',
  '<!-- caption | type: figure; id: fig-a -->',
  '正文 [[NEW]]新增内容[[/NEW]]，删除[[DEL]]旧内容[[/DEL]]。',
  '<w:drawing><wp:inline><a:graphic>原始图形</a:graphic></wp:inline></w:drawing>',
  '换行[[BR]]制表[[TAB]]脚注[[FN | content:"说明"]]',
  '片段[[SLOT intro]]',
].join('\n');

describe('docx preview preprocessor', () => {
  it('removes directives, markers, deleted text and raw drawing markup', () => {
    const preview = prepareDocxPreviewMarkdown(SOURCE);
    expect(preview).not.toContain('<!--');
    expect(preview).not.toContain('[[');
    expect(preview).not.toContain('旧内容');
    expect(preview).not.toContain('原始图形');
    expect(preview).not.toContain('w:drawing');
    expect(preview).toContain('新增内容');
    expect(preview).toContain('正文');
    expect(preview).toContain('<br>');
    expect(preview).toContain('intro');
    expect(preview).toContain('注');
  });

  it('keeps ordinary markdown untouched', () => {
    const markdown = '# 标题\n\n普通 [[wiki]] 链接和 <!-- 普通注释 -->';
    expect(isDocxMarkdownSource(markdown)).toBe(false);
    expect(prepareDocxPreviewMarkdown(markdown)).not.toContain('[[');
  });

  it('detects docx content by directives, known markers or file name', () => {
    expect(isDocxMarkdownSource('<!-- font | bold -->')).toBe(true);
    expect(isDocxMarkdownSource('正文 [[note]] 与 [[wiki]]')).toBe(false);
    expect(isDocxMarkdownSource('正文 [[NEW]]a[[/NEW]]')).toBe(true);
    expect(isDocxMarkdownSource('普通正文', '论文.docx.md')).toBe(true);
  });

  it('renders a sanitized preview without raw directives or drawing XML', () => {
    const html = renderPreview(SOURCE);
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('[[');
    expect(html).not.toContain('w:drawing');
    expect(html).not.toContain('原始图形');
    expect(html).toContain('新增内容');
    expect(html).not.toContain('旧内容');
  });
});
