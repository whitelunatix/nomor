import { describe, expect, it } from 'vitest';
import * as sourceDecorations from './sourceDecorations';
import {
  collectDocxSourceHighlights,
  isDocxDirectiveSourceLine,
} from './sourceDecorations';

describe('docx source decorations', () => {
  it('marks directive lines, invalid directives and inline markers', () => {
    const text = [
      '<!-- font | bold -->',
      '<!-- font | wat',
      '<!-- 普通注释 -->',
      '正文 [[NEW]]新增[[/NEW]] 和 [[TAB]]',
    ].join('\n');
    const highlights = collectDocxSourceHighlights(text);
    expect(highlights.filter((item) => item.lineClass === 'docx-source-directive')).toHaveLength(1);
    expect(
      highlights.filter((item) => item.lineClass === 'docx-source-directive-invalid'),
    ).toHaveLength(1);
    const marks = highlights.filter((item) => item.markClass === 'docx-source-inline-marker');
    expect(marks.map((item) => item.kind)).toEqual(['NEW', 'NEW', 'TAB']);
    expect(marks[0]).toMatchObject({ from: text.indexOf('[[NEW]]'), to: text.indexOf('[[NEW]]') + 7 });
  });

  it('marks unclosed inline brackets and skips code spans and fences', () => {
    expect(
      collectDocxSourceHighlights('正文 [[NEW | font').some(
        (item) => item.markClass === 'docx-source-inline-marker-invalid',
      ),
    ).toBe(true);
    expect(collectDocxSourceHighlights('`[[NEW]]`')).toEqual([]);
    expect(
      collectDocxSourceHighlights(['```markdown', '<!-- font | wat: 1 -->', '[[NEW]]', '```'].join('\n')),
    ).toEqual([]);
  });

  it('offsets ranges when scanning a viewport slice', () => {
    const slice = '<!-- font | bold -->\n正文';
    const highlights = collectDocxSourceHighlights(slice, 100);
    expect(highlights[0]).toMatchObject({ from: 100, to: 100, lineClass: 'docx-source-directive' });
  });

  it('recognizes complete and incomplete directive lines', () => {
    expect(isDocxDirectiveSourceLine('<!-- font | bold -->')).toBe(true);
    expect(isDocxDirectiveSourceLine('<!-- font | bold')).toBe(false);
    expect(isDocxDirectiveSourceLine('<!-- 普通注释 -->')).toBe(false);
  });

  it('does not expose directive folding ranges', () => {
    // 指令行只做高亮；源码编辑器不再挂折叠入口，这里保证模块不导出折叠 API。
    expect(Object.keys(sourceDecorations)).not.toContain('collectDocxDirectiveFoldRanges');
  });
});
