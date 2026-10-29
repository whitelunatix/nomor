import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { parseMarkdown, serializeMarkdown } from '../editor-core/markdown';
import { buildDocxDecorations, resetDocxPresentationCachesForTests } from './presentation';
import { DOCX_INLINE_PIPE_MARKER, maskInlineMarkerPipes, parseInlineMarker } from './inlineMarkers';

function collect(doc: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === type) nodes.push(node);
  });
  return nodes;
}

function markers(markdown: string): string[] {
  return Array.from(markdown.matchAll(/\[\[[\s\S]*?\]\]/g), (match) => match[0]);
}

const fixtureSource = readFileSync(
  resolve(process.cwd(), 'src/lib/docxmd/__fixtures__/all_features.docx.md'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('docx inline markers', () => {
  it('parses paired NEW markers with font groups', () => {
    const marker = parseInlineMarker('NEW | & font | style: underline');
    expect(marker?.role).toBe('open');
    expect(marker?.kind).toBe('NEW');
    expect(marker?.groups.map((group) => group.keyword)).toEqual(['font']);
    expect(marker?.groups[0]?.fields[0]?.rawName).toBe('style');
    expect(marker?.groups[0]?.fields[0]?.value).toBe('underline');
  });

  it('keeps quoted semicolons inside CMT content', () => {
    const marker = parseInlineMarker('CMT | content:"结果;修正"; author:"AI"');
    expect(marker?.kind).toBe('CMT');
    expect(marker?.content).toBe('结果;修正');
    expect(marker?.author).toBe('AI');
  });

  it('parses REF id and nested formatting group', () => {
    const marker = parseInlineMarker('REF | id:"1" & font | style: superscript');
    expect(marker?.kind).toBe('REF');
    expect(marker?.name).toBe('1');
    expect(marker?.groups.map((group) => group.keyword)).toEqual(['ref', 'font']);
  });

  it('uses marker node boundaries without leaking marker text into content', () => {
    const input = '温度 [[NEW | & font | style: superscript]]3[[/NEW]] 与 [[REF | id:"1" & font | style: superscript]]1[[/REF]]';
    const doc = parseMarkdown(input, { docx: true });
    const paragraph = doc.child(0);
    expect(paragraph.textContent).toBe('温度 3 与 1');
    expect(collect(doc, 'docx_inline_open')).toHaveLength(2);
    expect(collect(doc, 'docx_inline_close')).toHaveLength(2);
    expect(serializeMarkdown(doc)).toBe(input);
  });

  it('renders point markers as atoms and keeps them byte-identical', () => {
    const input = '第一行[[BR]]第二列[[TAB]]注[[FN | content:"来源"]]';
    const doc = parseMarkdown(input, { docx: true });
    const atoms = collect(doc, 'docx_inline_atom');
    expect(atoms.map((node) => node.attrs.kind)).toEqual(['BR', 'TAB', 'FN']);
    expect(atoms[2]?.attrs.content).toBe('来源');
    expect(parseMarkdown(input, { docx: true }).child(0).textContent).toBe(
      '第一行\n第二列\t注',
    );
    expect(serializeMarkdown(doc)).toBe(input);
  });

  it('parses a SLOT reference', () => {
    const marker = parseInlineMarker('SLOT winding-card');
    expect(marker?.role).toBe('atom');
    expect(marker?.name).toBe('winding-card');
  });

  it('supports table rows whose markers contain unescaped pipes', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    const tables = collect(doc, 'table');
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(TableMap.get(table).width).toBe(2);
      for (let row = 0; row < table.childCount; row += 1) {
        expect(table.child(row).childCount).toBe(2);
      }
    }
  });

  it('serializes every inline marker in order', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    const serialized = serializeMarkdown(doc);
    expect(markers(serialized)).toEqual(markers(fixtureSource));
  });

  it('protects literal pipes inside paired marker content', () => {
    const source = '| [[NEW | & paragraph]]电话 | 邮箱[[/NEW]] | 照片 |';
    const masked = maskInlineMarkerPipes(source);
    // 标记正文里的 `|` 换成同长度占位符，表格切分不会多出一列。
    expect(masked).not.toContain('电话 | 邮箱');
    expect(masked).toContain(`电话 ${DOCX_INLINE_PIPE_MARKER} 邮箱`);
    expect(masked).toHaveLength(source.length);
    // 标记外仍是真正的列分隔符。
    expect(masked.endsWith(' | 照片 |')).toBe(true);
  });

  it('leaves escaped pipes to Markdown escaping', () => {
    const source = '| [[NEW | & paragraph]]a \\| b[[/NEW]] | c |';
    expect(maskInlineMarkerPipes(source)).toContain('a \\| b');
  });

  it('keeps a literal pipe in a table cell from splitting the row', () => {
    const doc = parseMarkdown([
      '<!-- table | col.width: 14.35cm 4.45cm -->',
      '| [[NEW | & paragraph]]电话　18190186529　　|　　邮箱　a@b.c[[/NEW]] | ![照片](assets/photo.png) |',
      '|:---|:---|',
    ].join('\n'), { docx: true });
    const tables = collect(doc, 'table');
    expect(tables).toHaveLength(1);
    expect(TableMap.get(tables[0]!).width).toBe(2);
    expect(tables[0]!.textContent).toContain('电话　18190186529　　|　　邮箱');
  });

  it('decorates NEW ranges and cross references', () => {
    resetDocxPresentationCachesForTests();
    const input = [
      '<!-- global.font | mix: 宋体 10.5pt -->',
      '前 [[NEW | & font | color: #FF0000]]红[[/NEW]] [[REF | id:"12" & font | style: superscript]]12[[/REF]]',
    ].join('\n');
    const doc = parseMarkdown(input, { docx: true });
    const decorations = buildDocxDecorations(doc).find();
    const inline = decorations.filter((decoration) => 'from' in decoration && (decoration as { from: number }).from >= 0);
    const classes = inline.map((decoration) => String(decoration.spec?.attrs?.class ?? ''));
    expect(classes.some((value) => value.includes('docx-inline-region-new'))).toBe(true);
    expect(classes.some((value) => value.includes('docx-crossref'))).toBe(true);
    const styled = inline
      .map((decoration) => String(decoration.spec?.attrs?.style ?? ''))
      .join('\n');
    expect(styled).toContain('color: #FF0000');
    expect(styled).toContain('vertical-align: super');
  });
});
