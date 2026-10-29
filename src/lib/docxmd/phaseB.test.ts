import { beforeEach, describe, expect, it } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { parseMarkdown } from '../editor-core/markdown';
import { DocxMetaNodeView } from '../editor-core/nodeViews/DocxMetaNodeView';
import { buildDocxDecorations, resetDocxPresentationCachesForTests } from './presentation';
import { docxTableColumnWidths } from './tableWidths';

interface Decorated {
  from: number;
  to: number;
  attrs: Record<string, string>;
  node: ProseMirrorNode | null;
}

function decorationsFor(markdown: string): Decorated[] {
  const doc = parseMarkdown(markdown, { docx: true });
  const set = buildDocxDecorations(doc);
  return set.find().map((decoration) => ({
    from: decoration.from,
    to: decoration.to,
    attrs: { ...((decoration.spec?.attrs ?? {}) as Record<string, string>) },
    node: doc.nodeAt(decoration.from),
  }));
}

function attrsMatching(
  markdown: string,
  predicate: (item: Decorated) => boolean,
): Record<string, string> {
  return decorationsFor(markdown).find(predicate)?.attrs ?? {};
}

describe('docx phase B presentation', () => {
  beforeEach(() => {
    resetDocxPresentationCachesForTests();
  });

  it('applies thesis-style zh/en families with CJK sizes', () => {
    const markdown = [
      '<!-- var body = font | zh: 宋体 小四; en: Times New Roman 12pt & paragraph | align: justify; indent.firstLine: 2char; line.spacing: 1.25 -->',
      '<!-- use body -->',
      '正文',
    ].join('\n');
    const attrs = attrsMatching(
      markdown,
      (item) => item.node?.type.name === 'paragraph' && Boolean(item.attrs.style),
    );
    expect(attrs.style).toContain('font-family: "Times New Roman", 宋体');
    expect(attrs.style).toContain('font-size: 12pt');
    expect(attrs.style).toContain('text-indent: 2em');
  });

  it('maps hanging indentation for references', () => {
    const markdown = [
      '<!-- var refs = paragraph | special: hanging; special.by: 2char -->',
      '<!-- use refs -->',
      '<!-- reference | id: 1 -->',
      '[1] 参考文献条目。',
    ].join('\n');
    const attrs = attrsMatching(markdown, (item) => Boolean(item.attrs['data-docx-reference-id']));
    expect(attrs.style).toContain('padding-left: 2em');
    expect(attrs.style).toContain('text-indent: -2em');
    expect(attrs['data-docx-reference-id']).toBe('1');
    expect(attrs['data-docx-reference-auto']).toBeUndefined();
  });

  it('shows an automatic reference label only when the text has none', () => {
    const markdown = [
      '<!-- reference | id: 7 -->',
      '参考文献条目。',
    ].join('\n');
    const attrs = attrsMatching(markdown, (item) => Boolean(item.attrs['data-docx-reference-id']));
    expect(attrs['data-docx-reference-auto']).toBe('true');
  });

  it('decorates block images with width and alignment', () => {
    const markdown = [
      '<!-- @image.inline | size.width: 15.5cm; layout.align: center; layout.fit: max -->',
      '<!-- image -->',
      '![架构](fig/a.png)',
    ].join('\n');
    const attrs = attrsMatching(markdown, (item) => Boolean(item.attrs['data-docx-image-width']));
    expect(attrs['data-docx-image-width']).toBe('15.5cm');
    expect(attrs['data-docx-image-align']).toBe('center');
    expect(attrs['data-docx-image-fit']).toBe('max');
    expect(attrs.style).toContain('--docx-image-width: 15.5cm');
    expect(attrs.style).toContain('--docx-image-align: center');
  });

  it('numbers only captions without a manual label', () => {
    const markdown = [
      '<!-- caption | type: figure; id: fig-a -->',
      '图3-1　手工题注',
      '',
      '<!-- caption | type: figure; id: fig-b -->',
      '自动题注',
    ].join('\n');
    const entries = decorationsFor(markdown).filter((item) => item.attrs['data-docx-caption']);
    const manual = entries.find((item) => item.attrs['data-docx-caption-id'] === 'fig-a');
    const auto = entries.find((item) => item.attrs['data-docx-caption-id'] === 'fig-b');
    expect(manual?.attrs['data-docx-caption-number']).toBeUndefined();
    expect(auto?.attrs['data-docx-caption-number']).toBe('2');
    expect(auto?.attrs['data-docx-caption-prefix']).toBe('图');
  });

  it('adds formula numbering and break markers', () => {
    const markdown = [
      '<!-- formula | number: 2-1; id: eq-residual -->',
      '$$ y = x $$',
      '',
      '<!-- break | type: page; position: before -->',
      '新章节',
    ].join('\n');
    const entries = decorationsFor(markdown);
    const formula = entries.find((item) => item.attrs['data-docx-formula-number']);
    expect(formula?.attrs['data-docx-formula-number']).toBe('2-1');
    expect(formula?.node?.type.name).toBe('math_block');
    const pageBreak = entries.find((item) => item.attrs['data-docx-break-type']);
    expect(pageBreak?.attrs['data-docx-break-type']).toBe('page');
    expect(pageBreak?.attrs['data-docx-break-label']).toBe('分页符');
  });

  it('decorates table borders, header scope and explicit cells', () => {
    const markdown = [
      '<!-- @table.header | bg: #D9E2F3; border.visible: bottom; border.thickness: 0.75pt & font | style: bold -->',
      '<!-- @table.body | row.vAlign: center -->',
      '<!-- @table.cell | position: (1, 0) & paragraph | align: left -->',
      '<!-- table | border.visible: top bottom; border.thickness: 1.5pt; col.width: 4.2cm 4.2cm -->',
      '| 列A | 列B |',
      '|:---:|:---:|',
      '| 一 | 二 |',
    ].join('\n');
    const doc = parseMarkdown(markdown, { docx: true });
    const set = buildDocxDecorations(doc);
    const table = doc.child(0);
    expect(table.type.name).toBe('table');

    const wrapper = set
      .find()
      .map((decoration) => ({
        from: decoration.from,
        attrs: (decoration.spec?.attrs ?? {}) as Record<string, string>,
      }))
      .find((entry) => entry.from === 0 && entry.attrs['data-docx-table']);
    expect(wrapper?.attrs['data-docx-border']).toBe('top bottom');
    expect(wrapper?.attrs.style).toContain('--docx-table-border: 1.5pt solid #000000');

    const map = TableMap.get(table);
    // TableMap 偏移相对表格内容起点；文档位置 = 表格位置 + 1 + offset。
    const cellPositions = Array.from(new Set(map.map)).map((offset) => offset + 1);
    const cellStyles = set
      .find()
      .filter((decoration) => 'from' in decoration && cellPositions.includes(decoration.from))
      .map((decoration) => ({
        from: decoration.from,
        style: String((decoration.spec?.attrs as Record<string, string>)?.style ?? ''),
      }));
    const headerStyle = cellStyles.find((entry) => entry.from === cellPositions[0]);
    expect(headerStyle?.style).toContain('background-color: #D9E2F3');
    expect(headerStyle?.style).toContain('font-weight: 700');
    // 三线表：表头底边线独立于整张表的上下边框。
    expect(headerStyle?.style).toContain('border-bottom: 0.75pt solid #000000');
    const firstBody = cellStyles.find((entry) => entry.from === cellPositions[2]);
    expect(firstBody?.style).toContain('vertical-align: middle');
    expect(firstBody?.style).toContain('text-align: left');
  });

  it('applies @list.numbering format, start and indentation', () => {
    const markdown = [
      '<!-- @list.numbering | format: upperRoman; start: 3; indent.left: 1cm; indent.hanging: 0.74cm -->',
      '<!-- list | ordered: decimal -->',
      '1. 第一项',
      '2. 第二项',
    ].join('\n');
    const attrs = attrsMatching(
      markdown,
      (item) => item.node?.type.name === 'ordered_list' && Boolean(item.attrs['data-docx-list-format']),
    );
    expect(attrs['data-docx-list-format']).toBe('upper-roman');
    expect(attrs.start).toBe('3');
    expect(attrs.style).toContain('padding-left: 1cm');
    expect(attrs.style).toContain('text-indent: -0.74cm');
  });

  it('drops positive first-line indent on list containers so numbers are not followed by a tab-sized gap', () => {
    const markdown = [
      '<!-- paragraph | align: justify; indent.firstLine: 2char -->',
      '<!-- list | ordered: decimal -->',
      '3. 第三项',
      '4. 第四项',
    ].join('\n');
    const attrs = attrsMatching(
      markdown,
      (item) => item.node?.type.name === 'ordered_list' && Boolean(item.attrs.style),
    );
    // 列表项的首行缩进由列表几何负责，指令里的 2em 不能再叠加到编号后面。
    expect(attrs.style).toContain('text-align: justify');
    expect(attrs.style).not.toContain('text-indent');
  });

  it('resolves cross-reference labels from the document target registry', () => {
    const markdown = [
      '<!-- caption | type: figure; id: fig-a -->',
      '图3-1　架构图',
      '',
      '<!-- formula | number: 2-1; id: eq-residual -->',
      '$$ y = x $$',
      '',
      '正文见[[REF | id:"fig-a" & font | style: superscript]][1][[/REF]]与[[EQ | id:"missing"]](2-9)[[/EQ]]。',
    ].join('\n');
    const entries = decorationsFor(markdown);
    const crossrefs = entries.filter((item) =>
      String(item.attrs.class ?? '').includes('docx-crossref'),
    );
    const ref = crossrefs.find((item) => item.attrs['data-docx-target'] === 'fig-a');
    expect(ref?.attrs['data-docx-target-label']).toBe('图3-1');
    expect(ref?.attrs['class']).toContain('docx-crossref');
    expect(ref?.attrs['class']).not.toContain('docx-crossref-missing');
    const missing = crossrefs.find((item) => item.attrs['data-docx-target'] === 'missing');
    expect(missing?.attrs['class']).toContain('docx-crossref-missing');
  });

  it('reads fixed table column widths from the prefix', () => {
    const widths = docxTableColumnWidths([
      '<!-- table | border.visible: top bottom; col.width: 4.2cm 2.3cm 2.3cm -->',
    ]);
    expect(widths).toHaveLength(3);
    expect(widths![0]!).toBeCloseTo(158.74, 1);
    expect(widths![1]!).toBeCloseTo(86.93, 1);
  });

  it('summarizes structural directives in the meta node view', () => {
    const markdown = [
      '<!-- section | start: nextPage -->',
      '<!-- page | orientation: landscape; columns.count: 2 -->',
      '<!-- header | enabled: false -->',
      '正文',
    ].join('\n');
    const doc = parseMarkdown(markdown, { docx: true });
    const meta = doc.child(0);
    expect(meta.type.name).toBe('docx_meta');
    const view = new DocxMetaNodeView(meta, {} as never);
    const summary = view.dom.querySelector('.docx-meta-summary')?.textContent ?? '';
    expect(summary).toContain('第 1 节 · 下一页');
    expect(summary).toContain('横向');
    expect(summary).toContain('2 栏');
    expect(summary).toContain('无页眉');
    expect(view.dom.dataset.docxKind).toBe('section');
  });

  it('shows neutral clickable markers for snippets, shapes, objects and imports', () => {
    const cases: Array<[string, string, string]> = [
      ['<!-- import "../materials/source.rel.md" as ref -->', '导入', '导入 ref'],
      ['<!-- shape | id: bx1; preset: rect -->', '形状', '形状 rect · #bx1'],
      ['<!-- object | type: pageNumber; value: center -->', '对象', '对象 pageNumber · center'],
      ['<!-- snippet note -->', '片段', '片段 note'],
    ];
    for (const [directive, badge, summary] of cases) {
      const doc = parseMarkdown(`${directive}\n\n正文`, { docx: true });
      const meta = doc.child(0);
      expect(meta.type.name).toBe('docx_meta');
      const view = new DocxMetaNodeView(meta, {} as never, () => 0, () => undefined);
      expect(view.dom.querySelector('.docx-meta-badge')?.textContent).toBe(badge);
      expect(view.dom.querySelector('.docx-meta-summary')?.textContent).toBe(summary);
      expect(view.dom.dataset.docxActivatable).toBe('true');
    }
  });
});

