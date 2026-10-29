import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMarkdown } from '../editor-core/markdown';
import {
  buildDocxDecorations,
  resetDocxPresentationCachesForTests,
  resolveTableColumnWidths,
} from './presentation';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

function nodeDecorationAttrs(markdown: string): Array<Record<string, string>> {
  const doc = parseMarkdown(markdown, { docx: true });
  const set = buildDocxDecorations(doc);
  return set.find(0, doc.content.size).map((decoration) => ({ ...(decoration.spec.attrs as Record<string, string>) }));
}

/** 只取 `[[...]]...[[/...]]` 产生的行内装饰（widget 与块级装饰排除在外）。 */
function inlineDecorationAttrs(markdown: string): Array<Record<string, string>> {
  const doc = parseMarkdown(markdown, { docx: true });
  const set = buildDocxDecorations(doc);
  return set
    .find(0, doc.content.size)
    .filter((decoration) => {
      const attrs = decoration.spec.attrs as Record<string, string> | undefined;
      return decoration.from !== decoration.to && typeof attrs?.class === 'string'
        && attrs.class.includes('docx-inline-region');
    })
    .map((decoration) => ({ ...(decoration.spec.attrs as Record<string, string>) }));
}

/**
 * 段落组两侧的标记必须块级零高，否则 `<p>` 会为它们生成空行盒。
 * 节点装饰只能通过实际渲染后的 DOM 断言。
 */
function blockMarkerCount(markdown: string): number {
  const doc = parseMarkdown(markdown, { docx: true });
  const decorations = buildDocxDecorations(doc);
  const host = document.body.appendChild(document.createElement('div'));
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      plugins: [new Plugin({ props: { decorations: () => decorations } })],
    }),
  });
  const count = host.querySelectorAll('.docx-inline-block-marker').length;
  view.destroy();
  host.remove();
  return count;
}

function inlineWidgets(markdown: string) {
  const doc = parseMarkdown(markdown, { docx: true });
  const set = buildDocxDecorations(doc);
  return set.find(0, doc.content.size).filter(
    (decoration) => decoration.from === decoration.to
      && String(decoration.spec.key ?? '').startsWith('docx-paragraph-spacer'),
  );
}

describe('docx presentation', () => {
  beforeEach(() => {
    resetDocxPresentationCachesForTests();
  });

  it('applies font and paragraph directives to the following block', () => {
    const attrs = nodeDecorationAttrs(
      '<!-- font | mix: 宋体 10.5pt; style: bold -->\n<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->\n正文',
    );
    expect(attrs).toHaveLength(1);
    const style = attrs[0]!.style;
    expect(style).toContain('font-family: 宋体');
    expect(style).toContain('font-size: 10.5pt');
    expect(style).toContain('font-weight: 700');
    expect(style).toContain('text-align: justify');
    expect(style).toContain('text-indent: 2em');
    expect(style).toContain('line-height: 22pt');
  });

  it('applies global.font and var definitions through use', () => {
    const attrs = nodeDecorationAttrs(
      [
        '<!-- global.font | mix: 宋体 12pt -->',
        '<!-- var body = font | mix: 黑体 15pt & paragraph | align: center -->',
        '<!-- use body -->',
        '正文',
      ].join('\n'),
    );
    expect(attrs).toHaveLength(1);
    const style = attrs[0]!.style;
    expect(style).toContain('font-family: 黑体');
    expect(style).toContain('font-size: 15pt');
    expect(style).toContain('text-align: center');
  });

  it('expands fun definitions with arguments through use', () => {
    const attrs = nodeDecorationAttrs(
      [
        '<!-- fun projtitle(lead) = font | size: 10.5pt; style: bold & paragraph | space.before: {lead}; space.after: 0pt -->',
        '<!-- use projtitle(5pt) -->',
        '项目标题',
      ].join('\n'),
    );
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.style).toContain('font-size: 10.5pt');
    expect(attrs[0]!.style).toContain('margin-top: 5pt');
    expect(attrs[0]!.style).toContain('margin-bottom: 0pt');
  });

  it('applies groups that follow a use definition', () => {
    const attrs = nodeDecorationAttrs(
      [
        '<!-- var base = font | size: 9pt -->',
        '<!-- use base & paragraph | align: right -->',
        '正文',
      ].join('\n'),
    );
    expect(attrs[0]!.style).toContain('font-size: 9pt');
    expect(attrs[0]!.style).toContain('text-align: right');
  });

  it('treats use-expanded paragraph groups inside markers as block paragraphs', () => {
    const attrs = inlineDecorationAttrs(
      [
        '<!-- var bullet = paragraph | line.spacing: 14pt -->',
        '甲[[NEW | & use bullet]]正文[[/NEW]]',
      ].join('\n'),
    );
    expect(attrs).toHaveLength(1);
    expect(attrs[0]!.class).toContain('docx-inline-paragraph-group');
    expect(attrs[0]!.style).toContain('line-height: 14pt');
  });

  it('marks paragraph group boundaries as zero-height block markers', () => {
    expect(blockMarkerCount('甲[[NEW | & paragraph]]正文[[/NEW]]乙')).toBe(2);
    expect(
      blockMarkerCount(
        '<!-- var bullet = paragraph | line.spacing: 14pt -->\n甲[[NEW | & use bullet]]正文[[/NEW]]乙',
      ),
    ).toBe(2);
    expect(blockMarkerCount('甲[[NEW | & font | size: 9pt]]正文[[/NEW]]乙')).toBe(0);
  });

  it('keeps an empty paragraph group as a spacing widget', () => {
    const widgets = inlineWidgets(
      '甲[[NEW | & paragraph | line.spacing: 7pt]][[/NEW]]乙',
    );
    expect(widgets).toHaveLength(1);
  });

  it('does not emit a spacing widget for an empty non-paragraph group', () => {
    const widgets = inlineWidgets('甲[[NEW | & font | size: 9pt]][[/NEW]]乙');
    expect(widgets).toHaveLength(0);
  });

  it('marks a heading level only when it differs from the Markdown level', () => {
    const attrs = nodeDecorationAttrs('<!-- heading | level: h2 -->\n# 标题');
    expect(attrs[0]!['data-docx-heading-level']).toBe('2');

    const same = nodeDecorationAttrs('<!-- heading | level: h1 -->\n# 标题');
    expect(same[0]?.['data-docx-heading-level']).toBeUndefined();
  });

  it('maps list formats to CSS list styles', () => {
    const attrs = nodeDecorationAttrs('<!-- list | unordered: square -->\n- 项目');
    expect(attrs[0]!['data-docx-list-format']).toBe('square');
  });

  it('numbers headings from global heading numbering and local overrides', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- global.heading | decorators: [@heading.numbering | id: chapters; level: 1; format: decimal; text: 第%1章; @heading.numbering | id: chapters; level: 2; format: decimal; text: %1.%2; @heading.numbering | id: chapters; level: 3; format: decimal; text: %1.%2.%3] -->',
      '<!-- heading | level: h1 -->',
      '# 绪论',
      '<!-- heading | level: h2 -->',
      '## 研究背景',
      '<!-- heading | level: h3 -->',
      '### 国内现状',
      '<!-- heading | level: h1 -->',
      '# 方法',
    ].join('\n'));
    expect(
      attrs
        .map((item) => item['data-docx-heading-number-text'])
        .filter((value): value is string => typeof value === 'string'),
    ).toEqual(['第1章 ', '1.1 ', '1.1.1 ', '第2章 ']);

    const local = nodeDecorationAttrs([
      '<!-- heading | level: h1; decorators: [@heading.numbering | id: appendix; level: 1; format: upperLetter; text: 附录%1] -->',
      '# 补充材料',
    ].join('\n'));
    expect(local[0]!['data-docx-heading-number-text']).toBe('附录A ');
  });

  it('applies global heading numbering to headings without a local directive', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- global.heading | decorators: [@heading.numbering | id: chapters; level: 1; format: decimal; text: 第%1章] -->',
      '# 绪论',
      '# 方法',
    ].join('\n'));
    expect(
      attrs
        .map((item) => item['data-docx-heading-number-text'])
        .filter((value): value is string => typeof value === 'string'),
    ).toEqual(['第1章 ', '第2章 ']);
  });

  it('does not emit heading numbers without an explicit numbering rule', () => {
    const attrs = nodeDecorationAttrs('<!-- heading | level: h1 -->\n# 绪论');
    expect(attrs[0]?.['data-docx-heading-number-text']).toBeUndefined();
  });

  it('applies @table.paragraph to explicit paragraph groups inside a cell', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- @table.paragraph | position: (1, 0, 0) & font | color: #FF0000 & paragraph | align: left -->',
      '| H1 | H2 |',
      '| --- | --- |',
      '| [[NEW | & paragraph]]甲[[/NEW]] | 乙 |',
    ].join('\n'));
    expect(attrs.some((item) => item.style?.includes('color: #FF0000'))).toBe(true);
    expect(attrs.some((item) => item.style?.includes('text-align: left'))).toBe(true);
  });

  it('marks @table.continuation and merge arrows without fabricating structure', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- table | border.visible: all -->',
      '<!-- @table.continuation | startRows: 3, 20; title: 续{caption} -->',
      '| H1 | H2 |',
      '| --- | --- |',
      '| 甲 | ← |',
    ].join('\n'));
    expect(attrs.some((item) => item['data-docx-table-continuation'] === '3,20')).toBe(true);
    expect(attrs.some((item) => item['data-docx-merge-arrow'] === 'true')).toBe(true);
  });

  it('resolves literal and variable table column widths', () => {
    const doc = parseMarkdown([
      '<!-- table | col.width: 14.35cm 4.45cm -->',
      '| H1 | H2 |',
      '| --- | --- |',
      '| 甲 | 乙 |',
      '',
      '<!-- var head = table | col.width: 1.04cm 17.76cm -->',
      '<!-- use head -->',
      '| ![图标](assets/info.png) | 标题 |',
      '| --- | --- |',
    ].join('\n'), { docx: true });

    const tables: ProseMirrorNode[] = [];
    doc.descendants((node) => {
      if (node.type.name === 'table') tables.push(node);
    });
    expect(tables).toHaveLength(2);
    expect(resolveTableColumnWidths(doc, tables[0]!)).toEqual(['14.35cm', '4.45cm']);
    expect(resolveTableColumnWidths(doc, tables[1]!)).toEqual(['1.04cm', '17.76cm']);
  });

  it('supports slice selectors, cell padding and cell image widths', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- table | padding: 0pt -->',
      '<!-- @table.cell | position: (:, 0) | padding: 0pt 0.2cm 1pt 0pt & font | color: #5694C3 -->',
      '<!-- @table.cell | position: (0, 1) | padding: 0pt & image | size.width: 4.0cm -->',
      '| H1 | H2 |',
      '| --- | --- |',
      '| 甲 | 乙 |',
      '| 丙 | 丁 |',
    ].join('\n'));

    const firstColumn = attrs.filter((item) => item.style?.includes('color: #5694C3'));
    expect(firstColumn).toHaveLength(3);
    expect(firstColumn.every((item) => item.style?.includes('padding: 0pt 0.2cm 1pt 0pt'))).toBe(true);
    expect(attrs.some((item) => item.style?.includes('--docx-image-width: 4.0cm'))).toBe(true);
    const wrapper = attrs.find((item) => item['data-docx-table'] === 'true');
    expect(wrapper?.style).toContain('--docx-table-padding: 0pt');
  });

  it('keeps declared row height with row.height: fit', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- table | row.height: fit 0.5cm 0.5cm -->',
      '| H1 | H2 |',
      '| --- | --- |',
      '| 甲 | 乙 |',
    ].join('\n'));
    // 表头行 + 一个正文行；`fit` 只取第一个尺寸作为最小行高。
    const heights = attrs.filter((item) => item.style?.startsWith('height:'));
    expect(heights).toHaveLength(2);
    expect(heights.every((item) => item.style === 'height: 0.5cm')).toBe(true);
  });

  it('right-aligns tabs declared by a paragraph directive', () => {
    const doc = parseMarkdown(
      '<!-- var title = font | size: 10pt & paragraph | tabs: right 18.8cm -->\n'
      + '<!-- use title -->\nDocForge[[TAB]]Go',
      { docx: true },
    );
    const set = buildDocxDecorations(doc);
    const attrs = set
      .find(0, doc.content.size)
      .map((decoration) => ({ ...((decoration.spec.attrs ?? {}) as Record<string, string>) }));
    const block = attrs.find((item) => item['data-docx-tabs'] === 'right');
    expect(block?.style).toContain('--docx-tab-right: 18.8cm');
  });

  it('numbers captions and formulas by chapter with restart', () => {
    const attrs = nodeDecorationAttrs([
      '<!-- global.heading | decorators: [@heading.numbering | id: chapters; level: 1; format: decimal; text: 第%1章] -->',
      '<!-- heading | level: h1 -->',
      '# 绪论',
      '<!-- caption | type: figure; id: fig-a; decorators: [@caption.numbering | series: figures; label: 图; format: decimal; chapter.level: 1; separator: -; restart: chapter] -->',
      '系统结构',
      '<!-- caption | type: figure; id: fig-b; decorators: [@caption.numbering | series: figures; label: 图; format: decimal; chapter.level: 1; separator: -; restart: chapter] -->',
      '实验结果',
      '<!-- heading | level: h1 -->',
      '# 方法',
      '<!-- caption | type: table; id: tbl-a; decorators: [@caption.numbering | series: tables; label: 表; format: decimal; chapter.level: 1; separator: -; restart: chapter] -->',
      '参数',
      '<!-- formula | id: eq-a; decorators: [@formula.numbering | series: equations; format: decimal; chapter.level: 1; separator: -; restart: chapter] -->',
      '$$ E = mc^2 $$',
    ].join('\n'));

    expect(
      attrs
        .map((item) => item['data-docx-caption-number'])
        .filter((value): value is string => typeof value === 'string'),
    ).toEqual(['1-1', '1-2', '2-1']);
    expect(attrs.find((item) => item['data-docx-caption-id'] === 'fig-a')?.['data-docx-caption-prefix'])
      .toBe('图');
    expect(attrs.find((item) => item['data-docx-formula-id'] === 'eq-a')?.['data-docx-formula-number'])
      .toBe('2-1');
  });

  it('does not decorate ordinary markdown without docx directives', () => {
    const attrs = nodeDecorationAttrs('正文');
    expect(attrs).toHaveLength(0);
  });
});
