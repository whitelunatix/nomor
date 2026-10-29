import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildWordDocument } from './document';
import { createWordModel } from './model';
import { tryParseMarkdown } from '../../../lib/editor-core/markdown';
import type { WordDocument } from './protocol';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBFAAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
it('exports native superscript and subscript without source delimiters', async () => {
  const { document } = await model('x^2^ H~2~O <sup>中文</sup>');
  const { xml } = await unpack(document);
  expect(xml).toContain('w:vertAlign w:val="superscript"');
  expect(xml).toContain('w:vertAlign w:val="subscript"');
  expect(xml).not.toContain('^2^');
  expect(xml).not.toContain('~2~');
});
async function model(markdown: string) {
  const warnings = new Set<string>();
  const document = await createWordModel(markdown, '中文文档', new AbortController().signal, async () => null, warnings);
  return { document, warnings };
}
async function unpack(document: WordDocument) {
  const zip = await JSZip.loadAsync(await buildWordDocument(document));
  const text = (name: string) => zip.file(name)!.async('string');
  const xml = await text('word/document.xml');
  return { zip, text, xml, dom: new DOMParser().parseFromString(xml, 'application/xml') };
}
const find = (root: XMLDocument, name: string) => [...root.getElementsByTagName(`w:${name}`)];

describe('Word document export', () => {
  it('Word 识别内嵌和临时图片，不改变默认解析或生成不安全链接', async () => {
    const source = '![a](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==) ![b](blob:https://nomo.invalid/image) ![c](asset://localhost/a.png) ![d](file:///D:/a.png)\n\n[unsafe](data:image/png;base64,AAAA)';
    const before = tryParseMarkdown(source)!.toJSON();
    const seen: string[] = [];
    const document = await createWordModel(source, 'protocols', new AbortController().signal, async (node) => { seen.push(String(node.attrs?.src)); return null; }, new Set());
    expect(seen).toHaveLength(4);
    expect(seen[0]).toMatch(/^data:image\/gif/);
    expect(tryParseMarkdown(source)!.toJSON()).toEqual(before);
    const { text } = await unpack(document);
    expect(await text('word/_rels/document.xml.rels')).not.toContain('data:image');
  });
  it('未引用脚注仍保留正文，六级标题分别保留 Word 样式', async () => {
    const { document } = await model('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\n[^orphan]: 无引用但不能丢失');
    const { xml } = await unpack(document);
    for (let level = 1; level <= 6; level++) expect(xml).toContain(`w:val="Heading${level}"`);
    expect(xml).toContain('无引用但不能丢失');
  });
  it('保留标题、正文格式、中文、代码、注释，排除 Front Matter 和 Markdown 定界符', async () => {
    const { document } = await model('---\ntitle: secret\n---\n# 标题\n\n正文 **加粗** *斜体* ~~删除~~ <u>下划线</u> ==高亮== `x<y`\n\nline one  \nline two\n\n```ts\nconst x = 1;\n  next();\n```\n\n<!-- 注释内容 -->');
    const { xml, dom, text } = await unpack(document);
    expect(dom.querySelector('parsererror')).toBeNull();
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('加粗');
    expect(xml).not.toContain('**');
    expect(xml).not.toContain('secret');
    expect(xml).not.toContain('```');
    expect(xml).toContain('注释内容');
    expect(find(dom, 'b').length).toBeGreaterThan(0);
    expect(find(dom, 'i').length).toBeGreaterThan(0);
    expect(find(dom, 'strike').length).toBeGreaterThan(0);
    expect(find(dom, 'br').length).toBeGreaterThan(0);
    expect(await text('word/styles.xml')).toContain('宋体');
    expect(await text('docProps/core.xml')).toContain('中文文档');
  });

  it('原生编号保留起始数字，嵌套列表和独立列表互不续号，任务状态不泄漏标记', async () => {
    const { document } = await model('3. third\n4. fourth\n   - nested\n\ntext\n\n1. restart\n\n- [x] 完成\n- [ ] 未完成');
    const { xml, text } = await unpack(document);
    const numbering = await text('word/numbering.xml');
    expect(numbering).toContain('w:start w:val="3"');
    expect(numbering).toContain('w:start w:val="1"');
    expect(xml).toContain('w:numPr');
    expect(xml).toContain('nested');
    expect(xml).toContain('☑ ');
    expect(xml).toContain('☐ ');
    expect(xml).not.toContain('[x]');
    expect(xml).not.toContain('[ ]');
  });

  it('表格保留合并关系、对齐及表头且生成完整列网格', async () => {
    const { document } = await model('<table data-nomo-table="semantic"><tbody><tr><th colspan="2"><p>头</p></th><th><p>第三列</p></th></tr><tr><td rowspan="2"><p>跨行</p></td><td data-align="right"><p>右</p></td><td><p>A</p></td></tr><tr><td><p>B</p></td><td><p>C</p></td></tr></tbody></table>');
    const { xml, dom } = await unpack(document);
    expect(find(dom, 'tbl')).toHaveLength(1);
    expect(find(dom, 'gridCol')).toHaveLength(3);
    expect(xml).toContain('w:gridSpan w:val="2"');
    expect(xml).toContain('w:vMerge w:val="restart"');
    expect(xml).toContain('w:vMerge w:val="continue"');
    expect(xml).toContain('w:jc w:val="right"');
    expect(xml).toContain('w:tblHeader');
  });

  it('普通 Markdown 表格生成可编辑单元格并保留列对齐', async () => {
    const { document } = await model('| 左 | 右 |\n| :-- | --: |\n| a | **b** |');
    const { xml, dom } = await unpack(document);
    expect(find(dom, 'tbl')).toHaveLength(1);
    expect(find(dom, 'tc')).toHaveLength(4);
    expect(xml).toContain('w:jc w:val="right"');
    expect(xml).toContain('w:b');
  });

  it('重复标题和显式锚点分配唯一书签，目录可跳转，脚注使用原生 part', async () => {
    const { document } = await model('# 重复\n\n# 重复\n\n<!-- toc -->\n- [重复](#重复)\n<!-- /toc -->\n\n[跳转](#重复) [外部](https://example.com) <a id="here"></a>[锚点](#here) 正文[^a]\n\n[^a]: 脚注 **加粗**');
    const { xml, dom, text } = await unpack(document);
    const names = find(dom, 'bookmarkStart').map((element) => element.getAttribute('w:name'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(new Set(names).size).toBe(names.length);
    const links = find(dom, 'hyperlink').map((element) => element.getAttribute('w:anchor')).filter(Boolean);
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(links.every((id) => names.includes(id))).toBe(true);
    expect(xml).toContain('w:footnoteReference');
    expect(await text('word/footnotes.xml')).toContain('脚注');
    expect(await text('word/_rels/document.xml.rels')).toContain('https://example.com');
    expect(xml).not.toContain('[^a]');
  });

  it('将图片、行内公式、Mermaid 写入媒体关系，替代文字保留且不重复输出源码', async () => {
    const warnings = new Set<string>();
    const document = await createWordModel('![照片](x.png)\n\n行内 $x^2$ 结尾\n\n```mermaid\ngraph TD; A-->B\n```', 'media', new AbortController().signal,
      async () => 'test', warnings);
    document.media = [{ id: 'test', bytes: PNG, type: 'png', width: 100, height: 50 }];
    const { zip, xml, dom } = await unpack(document);
    expect(find(dom, 'drawing')).toHaveLength(3);
    expect(Object.keys(zip.files).filter((path) => path.startsWith('word/media/') && !zip.files[path].dir)).toHaveLength(1);
    expect(xml).toContain('照片');
    expect(xml).toContain('结尾');
    expect(find(dom, 't').map((n) => n.textContent).join('')).not.toContain('graph TD');
  });

  it('不支持的 HTML、缺失脚注与资源保留可读内容并提示', async () => {
    const { document, warnings } = await model('<iframe src="https://example.com"></iframe>\n\n![替代文字](missing.png)\n\n$x$\n\n[^missing]');
    const { xml } = await unpack(document);
    expect(xml).toContain('&lt;iframe');
    expect(xml).toContain('替代文字');
    expect(xml).toContain('$x$');
    expect(xml).toContain('[^missing]');
    expect(warnings.size).toBeGreaterThanOrEqual(2);
  });

  it('连续构建不复用编号、媒体、标题或脚注状态', async () => {
    const first = (await model('# old\n\n1. item\n\nref[^a]\n\n[^a]: note')).document;
    await unpack(first);
    const second = await unpack((await model('# new')).document);
    expect(second.xml).not.toContain('old');
    expect(second.xml).not.toContain('w:footnoteReference');
    expect(find(second.dom, 'bookmarkStart')[0].getAttribute('w:name')).toBe('nomo_1');
  });

  it('取消时停止转换而不启动更多资源任务', async () => {
    const abort = new AbortController();
    let count = 0;
    await expect(createWordModel('![a](a.png)\n\n![b](b.png)', 'cancel', abort.signal, async () => { count++; abort.abort(); return null; }, new Set())).rejects.toThrow();
    expect(count).toBe(1);
  });
});
