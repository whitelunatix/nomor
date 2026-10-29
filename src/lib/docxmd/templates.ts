/**
 * 属性面板的“添加指令”模板。
 *
 * 模板本身必须是有效指令；`templates.test.ts` 会逐条用正式解析器校验，
 * 避免面板插入一行永远无法生效的文本。
 */

export interface DocxDirectiveTemplate {
  label: string;
  raw: string;
}

/** 块级指令（挂在内容块的 `docxPrefix` 上）。 */
export const DOCX_BLOCK_TEMPLATES: DocxDirectiveTemplate[] = [
  { label: '字体', raw: '<!-- font | zh: 宋体 小四; en: Times New Roman 12pt -->' },
  {
    label: '段落',
    raw: '<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 1.5 -->',
  },
  {
    label: '标题',
    raw: '<!-- heading | level: h2 & font | zh: 黑体 三号; bold: true -->',
  },
  {
    label: '列表编号',
    raw: '<!-- @list.numbering | format: upperRoman; indent.left: 1cm; indent.hanging: 0.74cm -->',
  },
  {
    label: '表格',
    raw: '<!-- table | border.visible: top bottom; border.thickness: 1.5pt -->',
  },
  {
    label: '三线表表头',
    raw: '<!-- @table.header | bg: #FFFFFF; border.visible: bottom; border.thickness: 0.75pt & font | style: bold -->',
  },
  { label: '图题', raw: '<!-- caption | type: figure; id: fig-1 -->' },
  { label: '公式', raw: '<!-- formula | number: 1-1; id: eq-1 -->' },
  { label: '参考文献', raw: '<!-- reference | id: 1 -->' },
  { label: '分页', raw: '<!-- break | type: page; position: before -->' },
];

/** 结构指令（`docx_meta.rawLines`）。 */
export const DOCX_META_TEMPLATES: DocxDirectiveTemplate[] = [
  { label: '分节', raw: '<!-- section | start: nextPage -->' },
  { label: '页面', raw: '<!-- page | size: A4; orientation: portrait -->' },
  { label: '页眉', raw: '<!-- header | scope: all; position: center; content: 页眉文字 -->' },
  { label: '页脚', raw: '<!-- footer | scope: all; position: center; content: 页码 -->' },
  { label: '目录', raw: '<!-- toc | type: headings; levels: 1-3 -->' },
  { label: '全局字体', raw: '<!-- global.font | zh: 宋体 小四; en: Times New Roman 12pt -->' },
  {
    label: '全局段落',
    raw: '<!-- global.paragraph | align: justify; line.spacing: 1.5 -->',
  },
  { label: '变量', raw: '<!-- var body = font | zh: 宋体 小四 -->' },
];
