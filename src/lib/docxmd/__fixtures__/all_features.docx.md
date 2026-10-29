<!-- global.page | size: A4; margins: top2cm bottom2cm left2cm right2cm; columns.count: 1; gutter: 0.3cm -->
<!-- global.header | scope: all; position: center; content: 全功能示例文档 -->
<!-- global.footer | scope: all; position: center; content: 第 {PAGE} 页 / 共 {NUMPAGES} 页 -->
<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
<!-- toc | type: headings; levels: 1-2 -->
<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
<!-- toc | type: figures -->
<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
<!-- toc | type: tables -->

<!-- heading | level: h1 -->
<!-- font | mix: 黑体 16pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
# 第一章 全功能示例

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
本节覆盖段落、字体、行内格式与对象混排。正文包含 **加粗**、*斜体*、[[NEW | & font | style: underline]]下划线[[/NEW]]、[[NEW | & font | style: superscript]]上标[[/NEW]]、[[NEW | & font | color: #FF0000]]红色文字[[/NEW]]，行内公式 $x=1$，行内图片 [[NEW | & image | size.width: 2cm]]![行内示意图](tiny.png)[[/NEW]] 与文字、公式同段混排。

<!-- heading | level: h2 -->
<!-- font | mix: 黑体 14pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
## 1.1 列表

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
手动编号写出字面标记：

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: left; indent.firstLine: 0pt; line.spacing: 22pt -->
<!-- list | ordered: decimal -->
1. 手动有序第一项
2. 手动有序第二项

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: left; indent.firstLine: 0pt; line.spacing: 22pt -->
<!-- list | unordered: square -->
- 手动无序项

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
Word 自动编号在插入或删除条目后自动重排（条目标记由 Word 负责刷新）：

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: left; indent.firstLine: 0pt; line.spacing: 22pt -->
<!-- list | ordered: decimal; decorators: [@list.numbering | id: auto-steps; level: 1; format: decimal; text: %1.; suffix: tab] -->
1. 自动编号第一项
2. 自动编号第二项

<!-- heading | level: h2 -->
<!-- font | mix: 黑体 14pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
## 1.2 公式、引用与题注

<!-- font | mix: Times New Roman 12pt -->
<!-- paragraph | align: center; indent.firstLine: 0pt; line.spacing: 1.0 -->
<!-- formula | number: 1-1; id: eq-energy -->
$$ E = mc^2 $$

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
带编号的公式可用交叉引用：[[EQ | id:"eq-energy"]](1-1)[[/EQ]]；文献引用 [[REF | id:"1" & font | style: superscript]]1[[/REF]]，图题引用 [[FIG | id:"fig-system"]]图 1[[/FIG]]，表题引用 [[TBL | id:"tbl-results"]]表 1[[/TBL]]。

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
<!-- reference | id: 1 -->
[1] 参考文献条目。

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: center; indent.firstLine: 0pt -->
<!-- caption | type: figure; id: fig-system -->
图 1 系统结构

<!-- @image.inline | index: -1; size.width: 3cm -->
<!-- image | size.width: 3cm; layout.align: center -->
![系统结构图](tiny.png)

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: center; indent.firstLine: 0pt -->
<!-- caption | type: table; id: tbl-results -->
表 1 单元格内的图片、公式、手动列表与自动列表

<!-- @table.header | bg: #D9E2F3; color: #000000 & font | style: bold -->
<!-- @table.body | row.vAlign: center -->
<!-- @table.cell | position: (1, 0) & paragraph | align: left -->
<!-- table | border.visible: all; col.width: 4.2cm 4.2cm; layout.align: center; row.height: fit; row.vAlign: center -->
| 列A | 列B |
|:---:|:---:|
| $a=1$ [[NEW | & image | size.width: 1cm]]![小图](tiny.png)[[/NEW]] 文本 | [[NEW | & list | ordered: decimal]]手动一[[BR]]手动二[[/NEW]] |
| ↑ | [[NEW | & list | ordered: decimal & numbering | id: cell-steps; format: decimal; text: %1.; suffix: tab]]自动一[[BR]]自动二[[/NEW]] |
| 子项 | [[NEW | & list | unordered: disc; nest: 1]]子项 A[[BR]]子项 B[[/NEW]] |

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: center; indent.firstLine: 0pt -->
<!-- caption | type: table; id: tbl-merge -->
表 2 横向合并与段落组

<!-- table | border.visible: all; col.width: 4.2cm 4.2cm; layout.align: center -->
| 列C | 列D |
|:---|:---|
| 合并锚点 | ← |
| [[NEW | & paragraph]]段落组一[[/NEW]] | [[NEW | & paragraph]]段落组二[[/NEW]] |

<!-- heading | level: h2 -->
<!-- font | mix: 黑体 14pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
## 1.3 代码与批注

<!-- code | font: mix Consolas 9pt; background: #F5F5F5; border: 1px solid #DDDDDD; line.numbers: false -->
```python
def add(a, b):
    return a + b
```

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
批注示例：[[CMT | content:"请核对数据"; author:"AI"; initials:"AI"; status:"open"]]这段文字带批注[[/CMT]]。

<!-- heading | level: h1 -->
<!-- font | mix: 黑体 16pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
# 第二章 分节与页面

<!-- section | start: nextPage -->
<!-- page | orientation: landscape; columns.count: 2; columns.gap: 0.8cm; page.number.start: 3 -->
<!-- heading | level: h2 -->
<!-- font | mix: 黑体 14pt; style: bold -->
<!-- paragraph | align: left; indent.firstLine: 0pt -->
## 2.1 横向双栏

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
横向双栏页面中的段落，用于验证分节页面几何与页码重启。

<!-- font | mix: 宋体 10.5pt; style: norm -->
<!-- paragraph | align: justify; indent.firstLine: 2char; line.spacing: 22pt -->
尾段文本。
