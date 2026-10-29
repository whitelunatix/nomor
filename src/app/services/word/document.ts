import {
  AlignmentType, Bookmark, BorderStyle, Document, ExternalHyperlink, FootnoteReferenceRun,
  HeadingLevel, ImageRun, InternalHyperlink, LevelFormat, Packer, Paragraph, ShadingType,
  Table, TableCell, TableLayoutType, TableRow, TextRun, UnderlineType, VerticalAlign, WidthType,
  type IParagraphOptions, type IRunOptions, type INumberingOptions, type ParagraphChild,
} from 'docx';
import { normalizeLinkHref } from '../../../lib/editor-core/link';
import { WORD_CONTENT_HEIGHT_PX, WORD_CONTENT_WIDTH_PX, type WordDocument, type WordNode } from './protocol';

const PAGE_WIDTH = 9638; // 170 mm in twips
const FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '宋体' };
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D9DDE3' };
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
type Block = Paragraph | Table;
type Context = { indent?: number; shade?: string; align?: 'left' | 'center' | 'right'; width?: number };
const attr = (node: WordNode, key: string) => node.attrs?.[key];
const str = (node: WordNode, key: string) => String(attr(node, key) ?? '');
const children = (node: WordNode) => node.content ?? [];
const plain = (node: WordNode): string => node.text ?? children(node).map(plain).join('');

/** Worker 内的纯文档构建器；每次调用的编号、书签、脚注状态完全隔离。 */
export async function buildWordDocument(input: WordDocument): Promise<ArrayBuffer> {
  const media = new Map(input.media.map((item) => [item.id, item]));
  const anchors = new Map<string, string>();
  const emittedAnchors = new Set<string>();
  const footnoteNodes = new Map<string, WordNode>();
  const footnoteIds = new Map<string, number>();
  const footnoteReferences = new Set<string>();
  const numbering: INumberingOptions['config'][number][] = [];
  let headingIndex = 0;

  const anchor = (id: string) => {
    if (!anchors.has(id)) anchors.set(id, `nomo_${anchors.size + 1}`);
    return anchors.get(id)!;
  };
  input.headings.forEach((heading) => anchor(heading.id));
  const visit = (node: WordNode) => {
    if (node.type === 'footnote_ref') footnoteReferences.add(str(node, 'id'));
    if (node.type === 'footnote_def') {
      const id = str(node, 'id');
      if (!footnoteIds.has(id)) footnoteIds.set(id, footnoteIds.size + 1);
      footnoteNodes.set(id, node);
    }
    for (const key of ['id', 'name']) if (str(node, key) && node.type !== 'footnote_def') anchor(str(node, key));
    for (const mark of node.marks ?? []) {
      for (const key of ['id', 'name']) if (mark.attrs?.[key]) anchor(String(mark.attrs[key]));
    }
    children(node).forEach(visit);
  };
  input.nodes.forEach(visit);

  function bookmarks(ids: string[], runs: ParagraphChild[]): ParagraphChild[] {
    for (const id of new Set(ids.filter(Boolean))) {
      const name = anchor(id);
      if (emittedAnchors.has(name)) continue;
      emittedAnchors.add(name);
      runs = [new Bookmark({ id: name, children: runs })];
    }
    return runs;
  }

  function inline(node: WordNode, maxWidth = WORD_CONTENT_WIDTH_PX): ParagraphChild[] {
    let runs: ParagraphChild[];
    const asset = media.get(str(node, 'wordMedia'));
    if (asset) {
      const requested = str(node, 'width');
      const width = requested.endsWith('%') ? maxWidth * parseFloat(requested) / 100 : parseFloat(requested);
      const desired = Number.isFinite(width) && width > 0 ? width : asset.width;
      const scale = Math.min(desired / asset.width, maxWidth / asset.width, WORD_CONTENT_HEIGHT_PX / asset.height);
      runs = [new ImageRun({ type: asset.type, data: asset.bytes,
        transformation: { width: Math.max(1, asset.width * scale), height: Math.max(1, asset.height * scale) },
        altText: { name: str(node, 'alt') || node.type, description: str(node, 'alt') || str(node, 'tex') || str(node, 'code'), title: str(node, 'title') },
      })];
    } else if (node.type === 'hard_break') {
      runs = [new TextRun({ break: 1 })];
    } else if (node.type === 'footnote_ref') {
      const id = footnoteIds.get(str(node, 'id'));
      runs = [id ? new FootnoteReferenceRun(id) : new TextRun({ text: `[^${str(node, 'id')}]`, superScript: true })];
    } else {
      let text = node.text ?? '';
      if (node.type === 'image') text = str(node, 'alt') || str(node, 'src');
      if (node.type.startsWith('math_')) text = `$${str(node, 'tex')}$`;
      if (node.type === 'mermaid_block') text = str(node, 'code');
      if (node.type.startsWith('comment_')) text = `[${input.labels.comment}: ${str(node, 'content')}]`;
      const marks = new Set(node.marks?.map((mark) => mark.type));
      const style: IRunOptions = {
        text, bold: marks.has('strong'), italics: marks.has('em'), strike: marks.has('strikethrough'),
        underline: marks.has('underline') ? { type: UnderlineType.SINGLE } : undefined,
        highlight: marks.has('highlight') ? 'yellow' : undefined,
        superScript: marks.has('superscript'),
        subScript: marks.has('subscript'),
        ...(marks.has('code') ? { font: { ...FONT, ascii: 'Consolas', hAnsi: 'Consolas' }, size: 18,
          shading: { type: ShadingType.CLEAR, fill: 'F3F4F6' } } : {}),
      };
      runs = text ? text.split('\n').map((line, index) => new TextRun({ ...style, text: line, ...(index ? { break: 1 } : {}) }))
        : children(node).flatMap((child) => inline(child, maxWidth));
    }
    const link = node.type === 'html_anchor' ? node.attrs : node.marks?.find((mark) => mark.type === 'link')?.attrs;
    const href = normalizeLinkHref(link?.href);
    if (href?.startsWith('#')) {
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Keep the literal anchor. */ }
      const name = anchors.get(id);
      if (name) runs = [new InternalHyperlink({ anchor: name, children: runs })];
    } else if (href) {
      runs = [new ExternalHyperlink({ link: href, children: runs })];
    }
    return bookmarks([String(link?.id ?? ''), String(link?.name ?? '')], runs);
  }

  function paragraph(node: WordNode, context: Context = {}, extra: IParagraphOptions = {}) {
    const maxWidth = (context.width ?? PAGE_WIDTH) / 15 - (context.indent ?? 0) / 15;
    let runs = children(node).flatMap((child) => inline(child, maxWidth));
    if (!node.content && node.type !== 'paragraph') runs = inline(node, maxWidth);
    runs = bookmarks([str(node, 'id')], runs);
    return new Paragraph({ children: runs, alignment: context.align,
      ...(context.indent ? { indent: { left: context.indent } } : {}),
      ...(context.shade ? { shading: { fill: context.shade, type: ShadingType.CLEAR } } : {}),
      ...extra,
    });
  }

  function blocks(nodes: WordNode[], context: Context = {}): Block[] {
    return nodes.flatMap((node): Block[] => {
      switch (node.type) {
        case 'heading': {
          const heading = input.headings[headingIndex++];
          const level = Math.max(1, Math.min(6, Number(attr(node, 'level')) || 1));
          const runs = children(node).flatMap((child) => inline(child));
          return [new Paragraph({ heading: HEADINGS[level - 1],
            children: heading ? bookmarks([heading.id], runs) : runs, keepNext: true })];
        }
        case 'paragraph': {
          // Align block images without changing surrounding inline content.
          const onlyImage = children(node).length === 1 && children(node)[0].type === 'image' ? children(node)[0] : undefined;
          const align = onlyImage && str(onlyImage, 'align');
          return [paragraph(node, { ...context, ...(align === 'center' || align === 'right' || align === 'left' ? { align } : {}) })];
        }
        case 'html_block': {
          const heading = /^h([1-6])$/.exec(str(node, 'tag'));
          return [paragraph(node, context, heading ? { heading: HEADINGS[Number(heading[1]) - 1], keepNext: true } : {})];
        }
        case 'code_block':
          return plain(node).split('\n').map((line) => new Paragraph({
            children: [new TextRun({ text: line, font: { ...FONT, ascii: 'Consolas', hAnsi: 'Consolas' }, size: 18 })],
            indent: { left: context.indent ?? 0 }, spacing: { before: 0, after: 0, line: 240 },
            shading: { fill: 'F3F4F6', type: ShadingType.CLEAR },
          }));
        case 'blockquote': return blocks(children(node), { ...context, indent: (context.indent ?? 0) + 360, shade: 'F7F7F7' });
        case 'callout': return [new Paragraph({ children: [new TextRun({ text: str(node, 'type').toUpperCase(), bold: true })], keepNext: true }),
          ...blocks(children(node), { ...context, indent: (context.indent ?? 0) + 240, shade: 'F3F5F8' })];
        case 'ordered_list':
        case 'bullet_list': {
          const ref = `list_${numbering.length}`;
          const indent = (context.indent ?? 0) + 360;
          numbering.push({ reference: ref, levels: [{ level: 0,
            format: node.type === 'ordered_list' ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: node.type === 'ordered_list' ? '%1.' : '•', start: Math.max(1, Number(attr(node, 'order')) || 1),
            alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: indent, hanging: 240 } } },
          }] });
          return children(node).flatMap((item) => {
            const parts = children(item);
            const first = parts[0];
            const task = attr(item, 'wordTask');
            const firstNode = typeof task === 'boolean' && first ? { ...first, content: [
              { type: 'text', text: task ? '☑ ' : '☐ ' }, ...children(first),
            ] } : first;
            const lead = firstNode?.type === 'paragraph'
              ? [paragraph(firstNode, { ...context, indent }, typeof task === 'boolean' ? {} : { numbering: { reference: ref, level: 0 } })]
              : [new Paragraph({ numbering: { reference: ref, level: 0 } }), ...blocks(firstNode ? [firstNode] : [], { ...context, indent })];
            return [...lead, ...blocks(parts.slice(1), { ...context, indent })];
          });
        }
        case 'table': {
          const width = Math.max(720, (context.width ?? PAGE_WIDTH) - (context.indent ?? 0));
          const rows = children(node);
          const columnCount = Number(attr(node, 'wordColumns')) || Math.max(1, ...rows.map((row) => children(row).reduce((sum, cell) => sum + (Number(attr(cell, 'colspan')) || 1), 0)));
          const columnWidth = Math.floor(width / columnCount);
          const occupied: number[] = [];
          const tableRows = rows.map((row, rowIndex) => {
            let column = 0;
            const cells = children(row).map((cell) => {
              while ((occupied[column] ?? 0) > rowIndex) column++;
              const span = Math.max(1, Number(attr(cell, 'colspan')) || 1);
              const rowSpan = Math.max(1, Number(attr(cell, 'rowspan')) || 1);
              for (let i = column; i < column + span; i++) occupied[i] = rowIndex + rowSpan;
              column += span;
              const align = str(cell, 'align');
              const cellBlocks = blocks(children(cell), { width: columnWidth * span - 160,
                ...(align === 'center' || align === 'right' ? { align } : {}),
              });
              return new TableCell({ children: cellBlocks.length ? cellBlocks : [new Paragraph('')],
                width: { size: columnWidth * span, type: WidthType.DXA }, columnSpan: span, rowSpan,
                verticalAlign: VerticalAlign.TOP,
                ...(cell.type === 'table_header' ? { shading: { fill: 'EDF0F4', type: ShadingType.CLEAR } } : {}),
                margins: { top: 80, bottom: 80, left: 80, right: 80 },
              });
            });
            return new TableRow({ children: cells, tableHeader: children(row).every((cell) => cell.type === 'table_header') });
          });
          return [new Table({ rows: tableRows, width: { size: width, type: WidthType.DXA },
            columnWidths: Array(columnCount).fill(columnWidth), layout: TableLayoutType.FIXED,
            borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER },
          }), new Paragraph({ spacing: { after: 0 } })];
        }
        case 'toc_block': return input.headings.map((heading) => new Paragraph({ indent: { left: (heading.level - 1) * 240 },
          children: [new InternalHyperlink({ anchor: anchor(heading.id), children: [new TextRun(heading.title)] })] }));
        case 'footnote_def': return footnoteReferences.has(str(node, 'id')) ? []
          : [new Paragraph({ children: [new TextRun({ text: `[^${str(node, 'id')}]`, superScript: true })] }), ...blocks(children(node), context)];
        case 'horizontal_rule': return [new Paragraph({ border: { bottom: BORDER } })];
        case 'math_block':
        case 'mermaid_block': return [paragraph(node, { ...context, align: 'center' })];
        case 'comment_block': return [paragraph(node, context)];
        default: return node.content ? blocks(node.content, context) : [paragraph(node, context)];
      }
    });
  }

  const body = blocks(input.nodes);
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  for (const [id, node] of footnoteNodes) {
    if (!footnoteReferences.has(id)) continue;
    const content = blocks(children(node));
    // 当前 schema 的脚注包含段落；表格扩展仍保留文字，避免无效 footnote XML。
    footnotes[String(footnoteIds.get(id)!)] = { children: content.flatMap((block) => block instanceof Paragraph ? [block] : [new Paragraph(plain(node))]) };
  }
  const doc = new Document({ title: input.title, creator: 'Nomo',
    styles: { default: { document: { run: { font: FONT, size: 22, color: '202124' }, paragraph: { spacing: { after: 120, line: 360 } } } },
      paragraphStyles: [20, 16, 14, 12, 11, 11].map((size, index) => ({ id: `Heading${index + 1}`, name: `Heading ${index + 1}`,
        basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: size * 2, bold: true, color: '202124' },
        paragraph: { outlineLevel: index, keepNext: true, spacing: { before: 240, after: 120 } },
      })),
    }, numbering: { config: numbering }, footnotes,
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children: body.length ? body : [new Paragraph('')],
    }],
  });
  return Packer.toArrayBuffer(doc);
}
