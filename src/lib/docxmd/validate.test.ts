import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDocxMarkdown } from './validate';

function codes(markdown: string): string[] {
  return validateDocxMarkdown(markdown).diagnostics.map((item) => item.code);
}

describe('docx validation', () => {
  it('accepts a well-formed document using variables, lists and table selectors', () => {
    const markdown = [
      '<!-- global.page | size: A4 -->',
      '<!-- var body = font | zh: 宋体 小四 & paragraph | align: justify -->',
      '<!-- use body -->',
      '<!-- list | unordered: disc -->',
      '- 第一项',
      '- 第二项',
      '<!-- @table.cell | position: (1, 0) & paragraph | align: left -->',
      '| A | B |',
      '| --- | --- |',
      '| 一 | 二 |',
      '<!-- toc | type: headings; levels: 1-2 -->',
    ].join('\n');
    const result = validateDocxMarkdown(markdown);
    expect(result.diagnostics).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.directiveCount).toBe(6);
  });

  it('reports unclosed comments, missing pipes, quotes and brackets', () => {
    const result = validateDocxMarkdown([
      '<!-- font | bold',
      '<!-- font bold -->',
      '<!-- font | content: "abc -->',
      '<!-- table | decorators: [@table.header; @table.cell -->',
    ].join('\n'));
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'DOCX_UNCLOSED_DIRECTIVE',
        'DOCX_MISSING_PIPE',
        'DOCX_UNCLOSED_QUOTE',
        'DOCX_UNBALANCED_BRACKET',
      ]),
    );
    expect(result.diagnostics.find((item) => item.code === 'DOCX_UNCLOSED_DIRECTIVE')?.sourceLine).toBe(1);
  });

  it('reports unknown fields only where a field table exists', () => {
    const result = validateDocxMarkdown([
      '<!-- font | wat: 1 -->',
      '<!-- reference | id: r1; wat: 2 -->',
    ].join('\n'));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'DOCX_UNKNOWN_FIELD', sourceLine: 1, field: 'wat' }),
    ]);
  });

  it('accepts official fields missing from the bundled field snapshot', () => {
    const result = validateDocxMarkdown([
      '<!-- global.formula | inline.style: upright; block.style: native -->',
      '<!-- @toc.h1 | font | zh: 宋体 小四; en: Times New Roman 12pt -->',
    ].join('\n'));
    expect(result.diagnostics).toEqual([]);
  });

  it('reports undefined and circular use references', () => {
    const result = validateDocxMarkdown([
      '<!-- var a = font | bold & use b -->',
      '<!-- var b = font | bold & use a -->',
      '<!-- use missing -->',
    ].join('\n'));
    expect(result.diagnostics.some((item) => item.code === 'DOCX_USE_CYCLE')).toBe(true);
    expect(
      result.diagnostics.some(
        (item) => item.code === 'DOCX_UNDEFINED_USE' && item.field === 'missing',
      ),
    ).toBe(true);
  });

  it('resolves fun definitions called with arguments', () => {
    const result = validateDocxMarkdown([
      '<!-- fun projtitle(lead) = font | size: 10.5pt & paragraph | space.before: {lead} -->',
      '<!-- use projtitle(1pt) -->',
      '项目标题',
    ].join('\n'));
    expect(result.diagnostics).toEqual([]);
  });

  it('reports an undefined fun call by its bare name', () => {
    const result = validateDocxMarkdown('<!-- use g(1) -->\n正文');
    expect(
      result.diagnostics.some(
        (item) => item.code === 'DOCX_UNDEFINED_USE' && item.field === 'g',
      ),
    ).toBe(true);
  });

  it('reports duplicate ids and missing reference ids', () => {
    const result = validateDocxMarkdown([
      '<!-- caption | type: figure; id: fig-a -->',
      '图 A',
      '<!-- caption | type: figure; id: fig-a -->',
      '<!-- reference | content: 文献 -->',
    ].join('\n'));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DOCX_DUPLICATE_ID',
          sourceLine: 3,
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'DOCX_MISSING_ID',
          sourceLine: 4,
          severity: 'error',
        }),
      ]),
    );
    expect(result.errorCount).toBe(1);
  });

  it('rejects invalid or missing table cell selectors', () => {
    const result = validateDocxMarkdown([
      '<!-- @table.cell | position: (a, b) -->',
      '| A |',
      '| --- |',
      '| 一 |',
      '<!-- @table.paragraph | align: left -->',
      '| B |',
      '| --- |',
      '| 二 |',
    ].join('\n'));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_SELECTOR', sourceLine: 1, severity: 'error' }),
        expect.objectContaining({ code: 'DOCX_MISSING_POSITION', sourceLine: 5, severity: 'error' }),
      ]),
    );
  });

  it('accepts the official 3D @table.paragraph selector including slices', () => {
    const result = validateDocxMarkdown([
      '<!-- @table.paragraph | position: (1, 0, 0) & paragraph | align: left -->',
      '| A |',
      '| --- |',
      '| 一 |',
      '<!-- @table.paragraph | position: (1:, :2, 0:1) & font | style: bold -->',
      '| B |',
      '| --- |',
      '| 二 |',
    ].join('\n'));
    expect(result.diagnostics.filter((item) => item.code === 'DOCX_TABLE_SELECTOR')).toEqual([]);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('checks @table.continuation required fields and start rows', () => {
    const missing = validateDocxMarkdown('<!-- @table.continuation | startRows: 3 -->');
    expect(missing.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_CONTINUATION', field: 'title', severity: 'error' }),
      ]),
    );

    const malformed = validateDocxMarkdown(
      '<!-- @table.continuation | startRows: 3, 2; title: 续{caption} -->',
    );
    expect(malformed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_CONTINUATION', field: 'startRows', severity: 'warning' }),
      ]),
    );

    const valid = validateDocxMarkdown(
      '<!-- @table.continuation | startRows: 3, 20; title: 续{caption} -->',
    );
    expect(valid.diagnostics).toEqual([]);
  });

  it('checks caption and formula numbering decorators', () => {
    const result = validateDocxMarkdown(
      '<!-- caption | type: figure; decorators: [@caption.numbering | format: decimal; restart: chapter] -->\n图',
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_NUMBERING', field: 'series' }),
        expect.objectContaining({ code: 'DOCX_NUMBERING', field: 'label' }),
        expect.objectContaining({ code: 'DOCX_NUMBERING', field: 'chapter.level' }),
      ]),
    );

    const valid = validateDocxMarkdown(
      '<!-- caption | type: figure; decorators: [@caption.numbering | series: figures; label: 图; format: decimal; chapter.level: 1; separator: -; restart: chapter] -->\n图',
    );
    expect(valid.diagnostics).toEqual([]);

    expect(
      codes('<!-- @caption.numbering | series: figures; label: 图 -->'),
    ).toContain('DOCX_ORPHAN_DECORATOR');
  });

  it('accepts rectangular arrow merge regions', () => {
    const result = validateDocxMarkdown([
      '| → | 基本信息 | 备注 |',
      '| --- | --- | --- |',
      '| 名称 | 数值 | 说明 |',
      '| 正文 | ← | ← |',
    ].join('\n'));
    // 表头 `→` 合并前两列；末行 `← ←` 以「正文」为锚点合并整行。
    expect(result.diagnostics).toEqual([]);
  });

  it('reports arrows that cycle or leave the table', () => {
    const cycle = validateDocxMarkdown([
      '| A | B |',
      '| --- | --- |',
      '| → | ← |',
    ].join('\n'));
    expect(cycle.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_MERGE_GEOMETRY', sourceLine: 3, severity: 'error' }),
      ]),
    );

    const outside = validateDocxMarkdown([
      '| ← | A |',
      '| --- | --- |',
    ].join('\n'));
    expect(outside.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_MERGE_GEOMETRY', sourceLine: 1, severity: 'error' }),
      ]),
    );
  });

  it('reports merge regions that are not rectangular', () => {
    const result = validateDocxMarkdown([
      '| A | ↓ | C |',
      '| --- | --- | --- |',
      '| → | X | Z |',
    ].join('\n'));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TABLE_MERGE_GEOMETRY', sourceLine: 3, severity: 'error' }),
      ]),
    );
  });

  it('checks toc fields and section conflicts', () => {
    const result = validateDocxMarkdown([
      '<!-- toc | type: unknown; levels: 3-1 -->',
      '<!-- section | start: nextPage -->',
      '',
      '<!-- section | start: continuous -->',
      '正文',
    ].join('\n'));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DOCX_TOC_TYPE', sourceLine: 1 }),
        expect.objectContaining({ code: 'DOCX_TOC_LEVELS', sourceLine: 1 }),
        expect.objectContaining({ code: 'DOCX_SECTION_CONFLICT', sourceLine: 4 }),
      ]),
    );
  });

  it('warns about markdown lists without a bound list directive', () => {
    expect(codes('- 项')).toContain('DOCX_MISSING_LIST');
    expect(codes('<!-- list | unordered: disc -->\n- 项')).not.toContain('DOCX_MISSING_LIST');
    expect(codes('<!-- global.list | unordered: disc -->\n- 项')).not.toContain('DOCX_MISSING_LIST');
    expect(codes('<!-- use bullet -->\n- 项')).not.toContain('DOCX_MISSING_LIST');
  });

  it('matches paired inline markers and flags unclosed, orphan and TAB fields', () => {
    expect(codes('[[NEW]]新增[[/NEW]]')).toEqual([]);
    expect(codes('[[NEW]]没有闭合')).toContain('DOCX_INLINE_UNCLOSED_RANGE');
    expect(codes('只有结束[[/NEW]]')).toContain('DOCX_INLINE_UNMATCHED_CLOSE');
    expect(codes('[[NEW | font | bold')).toContain('DOCX_INLINE_UNCLOSED');
    expect(codes('[[TAB: 2]]')).toContain('DOCX_INLINE_TAB_FIELDS');
    expect(codes('[[TAB]]')).toEqual([]);
  });

  it('ignores directives and inline markers inside fenced code', () => {
    const markdown = [
      '```markdown',
      '<!-- font | wat: 1 -->',
      '[[NEW]]未闭合',
      '```',
    ].join('\n');
    expect(validateDocxMarkdown(markdown).diagnostics).toEqual([]);
  });

  it('keeps diagnostics sorted by line and counts severities', () => {
    const result = validateDocxMarkdown([
      '<!-- reference | content: 文献 -->',
      '<!-- font | wat: 1 -->',
    ].join('\n'));
    expect(result.diagnostics.map((item) => item.sourceLine)).toEqual([1, 2]);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
  });

  it('checks the phase E fixture without errors', () => {
    const fixture = readFileSync(
      resolve(process.cwd(), 'src/lib/docxmd/__fixtures__/phase_e_features.docx.md'),
      'utf8',
    );
    const result = validateDocxMarkdown(fixture);
    expect(result.directiveCount).toBeGreaterThanOrEqual(6);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });

  it('checks the shipped all-features fixture without errors', () => {
    const fixture = readFileSync(
      resolve(process.cwd(), 'src/lib/docxmd/__fixtures__/all_features.docx.md'),
      'utf8',
    );
    const result = validateDocxMarkdown(fixture);
    expect(result.directiveCount).toBeGreaterThan(60);
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });
});
