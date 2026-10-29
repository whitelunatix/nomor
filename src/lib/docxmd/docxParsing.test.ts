import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { parseMarkdown, serializeMarkdown } from '../editor-core/markdown';
import { parseDirectiveLine } from './directiveGrammar';

function walk(node: ProseMirrorNode, visit: (node: ProseMirrorNode) => void): void {
  visit(node);
  node.forEach((child) => walk(child, visit));
}

function collectNodes(doc: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  walk(doc, (node) => {
    if (node.type.name === type) nodes.push(node);
  });
  return nodes;
}

/** 只统计真正被 docx 规则识别的单行指令。 */
function directiveLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => parseDirectiveLine(line) !== null);
}

const fixtureSource = readFileSync(
  resolve(process.cwd(), 'src/lib/docxmd/__fixtures__/all_features.docx.md'),
  'utf8',
).replace(/\r\n/g, '\n');

const phaseEFixtureSource = readFileSync(
  resolve(process.cwd(), 'src/lib/docxmd/__fixtures__/phase_e_features.docx.md'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('docx semantic parsing', () => {
  it('hides every directive from the semantic document', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    expect(collectNodes(doc, 'docx_meta').length).toBeGreaterThan(0);

    const leaked: string[] = [];
    for (const type of ['comment_inline', 'comment_block']) {
      for (const node of collectNodes(doc, type)) {
        const raw = `<!--${String(node.attrs.content ?? '')}-->`;
        if (parseDirectiveLine(raw)) leaked.push(raw);
      }
    }
    expect(leaked).toEqual([]);
  });

  it('binds style directives to the following block', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    const headings = collectNodes(doc, 'heading');
    const first = headings.find((node) => node.textContent.includes('第一章 全功能示例'));
    expect(first).toBeDefined();
    expect(first!.attrs.docxPrefix).toEqual([
      '<!-- heading | level: h1 -->',
      '<!-- font | mix: 黑体 16pt; style: bold -->',
      '<!-- paragraph | align: left; indent.firstLine: 0pt -->',
    ]);
  });

  it('keeps global.* and TOC runs as separate structural meta nodes', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    const metas = collectNodes(doc, 'docx_meta');
    expect(metas[0]!.attrs.metaKind).toBe('global');
    expect(metas[0]!.attrs.rawLines).toEqual([
      '<!-- global.page | size: A4; margins: top2cm bottom2cm left2cm right2cm; columns.count: 1; gutter: 0.3cm -->',
      '<!-- global.header | scope: all; position: center; content: 全功能示例文档 -->',
      '<!-- global.footer | scope: all; position: center; content: 第 {PAGE} 页 / 共 {NUMPAGES} 页 -->',
    ]);
    const tocMetas = metas.filter((node) => node.attrs.metaKind === 'toc');
    expect(tocMetas).toHaveLength(3);
    expect(tocMetas[0]!.attrs.rawLines).toEqual([
      '<!-- font | mix: 宋体 10.5pt; style: norm -->',
      '<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->',
      '<!-- toc | type: headings; levels: 1-2 -->',
    ]);
  });

  it('skip blank lines between a directive and its target', () => {
    const doc = parseMarkdown('<!-- use body -->\n\n正文', { docx: true });
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).textContent).toBe('正文');
    expect(doc.child(0).attrs.docxPrefix).toEqual(['<!-- use body -->']);
  });

  it('keeps every directive line byte-identical after serialization', () => {
    const doc = parseMarkdown(fixtureSource, { docx: true });
    const serialized = serializeMarkdown(doc);
    expect(directiveLines(serialized)).toEqual(directiveLines(fixtureSource));
  });

  it('re-serializes the feature fixture without changing directive lines', () => {
    const once = serializeMarkdown(parseMarkdown(fixtureSource, { docx: true }));
    expect(directiveLines(once)).toEqual(directiveLines(fixtureSource));
    // 第二次序列化必须稳定：指令绑定不会被上一次输出改变。
    const twice = serializeMarkdown(parseMarkdown(once, { docx: true }));
    expect(directiveLines(twice)).toEqual(directiveLines(fixtureSource));
    expect(collectNodes(parseMarkdown(once, { docx: true }), 'table')).toHaveLength(2);
  });

  it('round-trips a directive-only document byte-for-byte', () => {
    const input = [
      '<!-- font | mix: 宋体 10.5pt; style: norm -->',
      '<!-- paragraph | align: justify; indent.firstLine: 2char -->',
      '正文第一段',
      '',
      '<!-- heading | level: h2 -->',
      '<!-- font | mix: 黑体 14pt -->',
      '## 小节',
    ].join('\n');
    const doc = parseMarkdown(input, { docx: true });
    expect(serializeMarkdown(doc)).toBe(input);
  });

  it('keeps ordinary comments as comment chips in docx documents', () => {
    const doc = parseMarkdown('<!-- TODO: 核对数据 -->\n\n正文', { docx: true });
    expect(collectNodes(doc, 'comment_inline').length).toBe(1);
    expect(collectNodes(doc, 'docx_meta').length).toBe(0);
  });

  it('does not change ordinary markdown parsing', () => {
    const input = '<!-- font | style: bold -->\n\n正文';
    const plain = parseMarkdown(input);
    expect(collectNodes(plain, 'docx_meta').length).toBe(0);
    expect(collectNodes(plain, 'comment_inline').length).toBe(1);
    expect(serializeMarkdown(plain)).toBe(input);
  });

  it('parses and round-trips the phase E fixture', () => {
    const doc = parseMarkdown(phaseEFixtureSource, { docx: true });
    expect(collectNodes(doc, 'heading').map((node) => node.attrs.level)).toEqual([1, 2, 7]);
    expect(collectNodes(doc, 'table')).toHaveLength(2);

    const once = serializeMarkdown(doc);
    expect(directiveLines(once)).toEqual(directiveLines(phaseEFixtureSource));
    expect(collectNodes(parseMarkdown(once, { docx: true }), 'heading').map((node) => node.attrs.level))
      .toEqual([1, 2, 7]);
  });

  it('parses ordered lists that start above 1 instead of falling back to a raw paragraph', () => {
    // markdown-it 给 ordered_list_open 的 `start` 属性是数字；恢复竖线占位符时
    // 不能假设所有 attr 值都是字符串，否则整篇文档解析失败并退化成单段原文。
    const input = '3. 第三项\n4. 第四项\n\n普通段落';
    const doc = parseMarkdown(input, { docx: true });

    expect(collectNodes(doc, 'ordered_list')).toHaveLength(1);
    expect(collectNodes(doc, 'list_item')).toHaveLength(2);
    expect(collectNodes(doc, 'paragraph').length).toBeGreaterThan(1);
    expect(serializeMarkdown(doc)).toBe(input);
  });

  it('parses 7–9 level headings in docx mode and round-trips the markers', () => {
    const input = '####### 七级标题\n\n######## 八级标题\n\n######### 九级标题';
    const doc = parseMarkdown(input, { docx: true });
    expect(collectNodes(doc, 'heading').map((node) => node.attrs.level)).toEqual([7, 8, 9]);
    expect(serializeMarkdown(doc)).toBe(input);

    // 普通 Markdown 仍是 CommonMark：超过 6 个 `#` 按正文处理。
    const plain = parseMarkdown('####### 七级标题');
    expect(collectNodes(plain, 'heading')).toHaveLength(0);
  });
});
