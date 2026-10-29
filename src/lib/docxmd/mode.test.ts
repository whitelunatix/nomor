import { describe, expect, it } from 'vitest';
import { detectDocxMarkdownContent, isDocxMarkdownPath, resolveDocxMode } from './mode';

describe('docx mode detection', () => {
  it('uses the .docx.md suffix first', () => {
    expect(isDocxMarkdownPath('C:/thesis/swputhesis.docx.md')).toBe(true);
    expect(isDocxMarkdownPath('notes.md')).toBe(false);
    expect(isDocxMarkdownPath(null)).toBe(false);
    expect(resolveDocxMode({ path: 'a/b/c.DOCX.MD' })).toBe(true);
  });

  it('locks the mode so deleting all directives does not flash back', () => {
    expect(resolveDocxMode({ path: 'notes.md', locked: true })).toBe(true);
  });

  it('detects strong content signals without the suffix', () => {
    expect(detectDocxMarkdownContent('<!-- global.page | size: A4 -->\n\n# Title')).toBe(true);
    expect(detectDocxMarkdownContent('<!-- use body -->\n\n正文')).toBe(true);
  });

  it('requires enough medium signals for ordinary comments', () => {
    const one = '<!-- font | style: bold -->\n\n正文';
    expect(detectDocxMarkdownContent(one)).toBe(false);
    const three = [
      '<!-- font | style: bold -->',
      '<!-- paragraph | align: center -->',
      '<!-- heading | level: h1 -->',
    ].join('\n\n');
    expect(detectDocxMarkdownContent(three)).toBe(true);
  });

  it('does not enable docx mode for plain markdown', () => {
    expect(detectDocxMarkdownContent('# 普通文档\n\n正文。')).toBe(false);
    expect(resolveDocxMode({ path: 'notes.md', markdown: '# 普通文档' })).toBe(false);
  });
});
