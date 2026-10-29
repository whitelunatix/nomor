import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
  MarkdownSerializerState,
} from 'prosemirror-markdown';
import {
  Slice,
  Fragment,
  type Mark,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from 'prosemirror-model';
import { schema, type TableColumnAlignment } from './schema';
import { serializeHtmlBlock, serializeHtmlInlineContent } from './html/pmToHtml';
import { serializeHtmlAnchorOpen } from './html/htmlAnchor';
import { serializeCallout } from './callout/calloutSerializer';
import { TOC_START_MARKER, TOC_END_MARKER } from '../toc/tocMarkers';
import { escapeHtmlAttr } from './markdownTokenizer';
import { serializeMarkdownLinkDestination, serializeMarkdownLinkTitle } from './link';
import { bareLinkHrefForText } from './bareLinks';
import { analyzeInlineSourceText, escapeInlineSourceLiteral, isInlineSourceText, projectInlineSource, readTaskListMarker } from './InlineSourceCodec';
import { parseInlineMarker } from '../docxmd/inlineMarkers';

const paragraphSyntaxRanges = new WeakMap<MarkdownSerializerState, Array<{ from: number; to: number }>>();

type BlockSerializerHandler = (
  state: MarkdownSerializerState,
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
) => void;

interface MutableSerializerState extends MarkdownSerializerState {
  out: string;
  closed?: ProseMirrorNode | null;
  atBlank(): boolean;
  flushClose(size?: number): void;
}

interface OutputSnapshot {
  prefix: string;
  blank: boolean;
  tail: string;
}

/**
 * prosemirror-markdown 的默认状态在每次写入前都要读 `out`：
 * `atBlank()` 看最后一个字符，`text()` 还要 `out.slice(-2)`。
 * V8 里 `+=` 产生的是 rope，任意一次读取都会把整串拍平，
 * 于是整篇序列化退化成平方级（论文 149 KB 实测约 150 ms，其中 >90% 是拍平）。
 *
 * 这里用尾部标记（末字符、末两字符）代替读取：写入只做追加，
 * 只有最后取 `out` 时才合并一次。语义与上游实现逐行对应。
 */
const SerializerStateBase = MarkdownSerializerState as unknown as new (
  nodes: MarkdownSerializer['nodes'],
  marks: MarkdownSerializer['marks'],
  options: MarkdownSerializerState['options'],
) => MarkdownSerializerState;

class BufferedSerializerState extends SerializerStateBase {
  // 以下成员存在于运行时实现，但未写入 prosemirror-markdown 的类型声明。
  declare out: string;
  declare delim: string;
  declare closed: ProseMirrorNode | null;
  declare atBlockStart: boolean;

  private outBlank = true;
  private outTail = '';

  atBlank(): boolean {
    return this.outBlank;
  }

  ensureNewLine(): void {
    if (!this.outBlank) this.append('\n');
  }

  write(content?: string): void {
    this.flushClose();
    if (this.delim && this.outBlank) this.append(this.delim);
    if (content) this.append(content);
  }

  flushClose(size = 2): void {
    if (!this.closed) return;
    if (!this.outBlank) this.append('\n');
    if (size > 1) {
      let delimMin = this.delim;
      const trim = /\s+$/.exec(delimMin);
      if (trim) delimMin = delimMin.slice(0, delimMin.length - trim[0].length);
      for (let i = 1; i < size; i += 1) this.append(`${delimMin}\n`);
    }
    this.closed = null;
  }

  text(text: string, escape = true): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      this.write();
      if (!escape && lines[i][0] === '[' && /(^|[^\\])!$/.test(this.outTail)) {
        this.out = this.out.slice(0, this.out.length - 1) + '\\!';
        this.outTail = '\\!';
      }
      this.append(escape ? this.esc(lines[i], this.atBlockStart) : lines[i]);
      if (i !== lines.length - 1) this.append('\n');
    }
  }

  /**
   * 把已写内容暂存，后续渲染进入独立缓冲区。
   * 空白/尾部标记保持前缀的语义：行内渲染仍要判断是否需要补 `delim`，
   * `text()` 也要看前缀末尾是否已有 `!`。
   */
  suspendOutput(): OutputSnapshot {
    const snapshot = { prefix: this.out, blank: this.outBlank, tail: this.outTail };
    this.out = '';
    return snapshot;
  }

  /** 取出独立缓冲区内容并恢复暂存的前缀。 */
  resumeOutput(snapshot: OutputSnapshot): string {
    const chunk = this.out;
    this.out = snapshot.prefix;
    this.outBlank = snapshot.blank;
    this.outTail = snapshot.tail;
    return chunk;
  }

  appendRaw(chunk: string): void {
    this.append(chunk);
  }

  private append(chunk: string): void {
    if (!chunk) return;
    this.out += chunk;
    this.outBlank = chunk.charCodeAt(chunk.length - 1) === 10;
    this.outTail = chunk.length >= 2 ? chunk.slice(-2) : (this.outTail + chunk).slice(-2);
  }
}

/** 按源码原样写入一行，不做 Markdown 转义（指令行必须逐字保留）。 */
function writeRawDirectiveLine(state: MarkdownSerializerState, line: string): void {
  state.write(line);
  state.write('\n');
}

/**
 * `.docx.md` 指令是目标块的前缀，序列化时先写回原始行。
 * 普通 Markdown 节点没有 `docxPrefix`，行为完全不变。
 */
function withDocxPrefix(handler: BlockSerializerHandler): BlockSerializerHandler {
  const wrapped: BlockSerializerHandler = (state, node, parent, index) => {
    const prefix = node.attrs?.docxPrefix as unknown;
    if (Array.isArray(prefix) && prefix.length) {
      const prefixLines = prefix.map((line) => String(line));
      const mutable = state as MutableSerializerState;
      // 前缀与上一个普通块之间保留正常的块间距；但紧跟在 `docx_meta` 后时
      // 不再插入空行，否则 `section/page` 与后续 `heading` 指令会被拆成两组。
      if (mutable.closed?.type?.name === 'docx_meta') mutable.flushClose(1);
      else mutable.flushClose();
      for (const line of prefixLines) writeRawDirectiveLine(state, line);
    }
    handler(state, node, parent, index);
  };
  return wrapped;
}

const wrappedSerializerHandlers = new WeakSet<BlockSerializerHandler>();
const serializerHandlerCache = new WeakMap<BlockSerializerHandler, BlockSerializerHandler>();

function wrapSerializerNodes(serializer: MarkdownSerializer): void {
  const nodes = serializer.nodes as unknown as Record<string, BlockSerializerHandler | undefined>;
  for (const name of Object.keys(nodes)) {
    // docx_meta 自己负责写回原始行，不能再加前缀。
    if (name === 'docx_meta') continue;
    const handler = nodes[name];
    if (typeof handler !== 'function' || wrappedSerializerHandlers.has(handler)) continue;
    let wrapped = serializerHandlerCache.get(handler);
    if (!wrapped) {
      wrapped = withDocxPrefix(handler);
      serializerHandlerCache.set(handler, wrapped);
      wrappedSerializerHandlers.add(wrapped);
    }
    nodes[name] = wrapped;
  }
}

const tableMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    details(state, node) {
      const title = serializeHtmlInlineContent(projectInlineSource(node.child(0)));
      state.text(`<details${node.attrs.defaultOpen ? ' open' : ''}>\n<summary>${title}</summary>\n`, false);
      state.write('\n');
      state.renderContent(node.child(1));
      flushPendingClosedBlock(state);
      state.ensureNewLine();
      state.write('</details>');
      state.closeBlock(node);
    },
    details_summary(state, node) { state.renderInline(node); state.closeBlock(node); },
    details_body(state, node) { state.renderContent(node); },
    horizontal_rule(state, node, parent, index) {
      if (parent.type === schema.nodes.list_item && index === 0) {
        // 列表首块不能输出 - ---，否则保存后会被当作列表外的分割线。
        state.write('***\n');
        state.closeBlock(node);
      } else {
        defaultMarkdownSerializer.nodes.horizontal_rule(state, node, parent, index);
      }
    },
    code_block(state, node) {
      const code = node.textContent;
      const params = String(node.attrs.params ?? '');
      // 反引号围栏的 info 不能含反引号；正文中的同类符号串也不能提前闭合围栏。
      const marker = params.includes('`') ? '~' : '`';
      let fenceLength = 3;
      for (const match of code.matchAll(marker === '~' ? /~+/g : /`+/g)) {
        fenceLength = Math.max(fenceLength, match[0].length + 1);
      }
      const fence = marker.repeat(fenceLength);
      state.write(`${fence}${params}\n`);
      state.text(code, false);
      state.write('\n');
      state.write(fence);
      state.closeBlock(node);
    },
    paragraph(state, node, parent, index) {
      const taskParagraph = parent.type === schema.nodes.list_item && index === 0
        ? splitTaskParagraph(node)
        : null;
      if (taskParagraph) {
        state.write(taskParagraph.marker);
        renderParagraphInline(state, taskParagraph.content);
        state.closeBlock(node);
        return;
      }
      if (node.content.size === 0) {
        // 空段落只需要触发前一个块落盘；不写入当前列表缩进，避免保存成带空格的“空行”。
        flushPendingClosedBlock(state);
      } else {
        renderParagraphInline(state, node);
      }
      state.closeBlock(node);
    },
    hard_break(state, node, parent, index) {
      if (parent.type.name === 'heading' || parent.type.name === 'footnote_def') {
        // 标题和脚注定义必须保持一条源码行，显式保存定义内的软/硬换行属性。
        state.write(`<br data-nomo-break="${node.attrs.soft === true ? 'soft' : 'hard'}">`);
        return;
      }
      if (node.attrs.soft === true) {
        if (hasFollowingInlineContent(parent, index)) {
          state.write('\n');
        }
        return;
      }

      if (!hasFollowingInlineContent(parent, index)) {
        // Markdown 行尾转义无法保留段尾硬换行，使用已有 HTML 换行表示往返。
        state.write('<br>');
        return;
      }
      defaultMarkdownSerializer.nodes.hard_break(state, node, parent, index);
    },
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    ordered_list(state, node) {
      const start = node.attrs.order ?? 1;
      const maxWidth = String(start + node.childCount - 1).length;
      state.renderList(node, state.repeat(' ', maxWidth + 2), (index) => {
        const marker = String(start + index);
        return state.repeat(' ', maxWidth - marker.length) + marker + '. ';
      });
    },
    table(state, node) {
      state.text(serializeTable(node), false);
      state.closeBlock(node);
    },
    table_row() {
      return;
    },
    table_cell() {
      return;
    },
    table_header() {
      return;
    },
    html_block(state, node) {
      const html = serializeHtmlBlock(node);
      state.text(html, false);
      state.closeBlock(node);
    },
    html_anchor(state, node) {
      state.write(`${serializeHtmlAnchorOpen(node.attrs)}</a>`);
    },
    comment_block(state, node) {
      state.text(serializeMarkdownComment(String(node.attrs.content ?? ''), true), false);
      state.closeBlock(node);
    },
    toc_block(state, node) {
      const content = String(node.attrs.content ?? '').replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
      state.text(
        [TOC_START_MARKER, ...(content ? [content] : []), TOC_END_MARKER].join('\n'),
        false,
      );
      state.closeBlock(node);
    },
    image(state, node, parent) {
      const src = String(node.attrs.src ?? '');
      const alt = String(node.attrs.alt ?? '');
      const title = node.attrs.title as string | null;
      const align = node.attrs.align as string | null;
      const width = node.attrs.width as string | null;

      if (parent.type.name !== 'heading' && (align === 'left' || align === 'center' || align === 'right')) {
        // 有对齐 → 块级 HTML：<p align="...">\n  <img ...>\n</p>
        const from = (state as unknown as { out: string }).out.length;
        state.ensureNewLine();
        let imgTag = `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}"`;
        if (title) imgTag += ` title="${escapeHtmlAttr(title)}"`;
        if (width) imgTag += ` width="${escapeHtmlAttr(width)}"`;
        imgTag += '>';
        state.write(`<p align="${align}">\n  ${imgTag}\n</p>`);
        paragraphSyntaxRanges.get(state)?.push({ from, to: (state as unknown as { out: string }).out.length });
        state.closeBlock(node);
      } else if (width && parent.type.name !== 'heading') {
        // 只有宽度 → 内联 <img ...>（不换行，保留在段落内）
        let imgTag = `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}"`;
        if (title) imgTag += ` title="${escapeHtmlAttr(title)}"`;
        imgTag += ` width="${escapeHtmlAttr(width)}"`;
        imgTag += '>';
        state.write(imgTag);
      } else {
        // 标题必须保持单行；图片属性使用已有 Markdown 属性语法保存。
        const escapedAlt = escapeInlineSourceLiteral(alt).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
        const escapedSrc = serializeMarkdownLinkDestination(src);
        const titleStr = title ? ` "${serializeMarkdownLinkTitle(title)}"` : '';
        state.write(`![${escapedAlt}](${escapedSrc}${titleStr})`);
        if (parent.type.name === 'heading') {
          const attrs: string[] = [];
          if (align === 'left' || align === 'center' || align === 'right') attrs.push(`align=${align}`);
          if (width) attrs.push(`width=${width}`);
          if (attrs.length) state.write(`{${attrs.join(' ')}}`);
        }
      }
    },
    math_inline(state, node) {
      const tex = String(node.attrs.tex).replace(/(\\*)\$/g, (match, slashes: string) =>
        slashes.length % 2 === 1 ? match : `${slashes}\\$`,
      );
      state.write(`$${tex}$`);
    },
    comment_inline(state, node, parent, index) {
      const content = String(node.attrs.content ?? '');
      // 段首含邻项、空白行和标题会打断 Markdown 行内边界，复用既有 HTML 注释节点表示。
      if (
        content.includes('\n') && (
          parent.type.name === 'heading' ||
          (parent.childCount > 1 && (index === 0 || /\n[ \t]*\n/.test(content)))
        )
      ) {
        state.write(serializeHtmlInlineComment(content));
      } else {
        state.write(serializeMarkdownComment(content, false));
      }
    },
    footnote_ref(state, node) {
      state.write(`[^${node.attrs.id}]`);
    },
    footnote_def(state, node) {
      state.ensureNewLine();
      state.write(`[^${node.attrs.id}]:`);
      const first = node.firstChild;
      if (first?.type.name === 'paragraph') {
        // 首个段落与标记同一行，后续块统一缩进 4 个空格。
        state.write(' ');
        state.wrapBlock('    ', '', node, () => {
          state.renderInline(first);
          state.closeBlock(first);
          for (let index = 1; index < node.childCount; index += 1) {
            state.render(node.child(index), node, index);
          }
        });
      } else {
        state.wrapBlock('    ', '', node, () => state.renderContent(node));
      }
    },
    text(state, node, parent) {
      if (isInlineSourceText(node)) {
        const from = (state as unknown as { out: string }).out.length;
        state.text(node.text ?? '', false);
        if (node.marks.some((mark) => mark.type.name === 'inline_source' && mark.attrs.literal === true)) {
          paragraphSyntaxRanges.get(state)?.push({ from, to: (state as unknown as { out: string }).out.length });
        }
        return;
      }
      let escaped = escapeMarkdownTextWithoutManualInlineMarkers(node.text ?? '');
      if (containsLiteralDisplayMathSyntax(parent)) {
        escaped = escaped.replace(/(?<!\\)\$/g, '\\$');
      }
      const atBlank = (state as unknown as { atBlank(): boolean }).atBlank();
      state.text(atBlank ? escapeMarkdownBlockStart(escaped) : escaped, false);
    },
    math_block(state, node) {
      state.text(['$$', node.attrs.tex as string, '$$'].join('\n'), false);
      state.closeBlock(node);
    },
    mermaid_block(state, node) {
      const code = node.attrs.code as string;
      let fence = '```';
      for (const match of code.matchAll(/`+/g)) {
        if (match[0].length >= fence.length) fence = '`'.repeat(match[0].length + 1);
      }
      state.text([`${fence}mermaid`, code, fence].join('\n'), false);
      state.closeBlock(node);
    },
    callout(state, node) {
      serializeCallout(state, node);
    },
    /** 结构指令（global/page/section/toc/...）逐字写回，位置即节点位置。 */
    docx_meta(state, node) {
      const lines = Array.isArray(node.attrs.rawLines) ? node.attrs.rawLines : [];
      for (const line of lines) writeRawDirectiveLine(state, String(line));
      // 不调用 closeBlock：结构指令与后续指令/内容必须保持相邻，
      // 否则 renderContent/flushClose 会在 `section`、`toc` 与下一个块之间插入空行。
    },
    /** 行内标记逐字写回；标记内部的 `|` 在表格单元格里也不转义。 */
    docx_inline_open(state, node) {
      state.write(String(node.attrs.raw ?? ''));
    },
    docx_inline_close(state, node) {
      state.write(String(node.attrs.raw ?? ''));
    },
    docx_inline_atom(state, node) {
      state.write(String(node.attrs.raw ?? ''));
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    inline_source: { open: '', close: '', mixable: true },
    em: {
      ...defaultMarkdownSerializer.marks.em,
      open(_state, mark, parent, index) {
        return emphasisNeedsHtml(mark, parent, index) ? '<em>' : '*';
      },
      close(_state, mark, parent, index) {
        return emphasisNeedsHtml(mark, parent, index) ? '</em>' : '*';
      },
    },
    strong: {
      ...defaultMarkdownSerializer.marks.strong,
      open(_state, mark, parent, index) {
        return emphasisNeedsHtml(mark, parent, index) ? '<strong>' : '**';
      },
      close(_state, mark, parent, index) {
        return emphasisNeedsHtml(mark, parent, index) ? '</strong>' : '**';
      },
    },
    strikethrough: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    underline: {
      open: '<u>',
      close: '</u>',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    superscript: { open: '<sup>', close: '</sup>', mixable: true },
    subscript: { open: '<sub>', close: '</sub>', mixable: true },
    kbd: { open: '<kbd>', close: '</kbd>', mixable: true, expelEnclosingWhitespace: true },
    highlight: {
      open: '<mark>',
      close: '</mark>',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    link: {
      open(_state, mark, parent, index) {
        if (mark.attrs.html) return serializeHtmlAnchorOpen(mark.attrs);
        if (isBareAutoLink(mark, parent, index, 'open')) return '';
        return '[';
      },
      close(_state, mark, parent, index) {
        if (mark.attrs.html) return '</a>';
        if (isBareAutoLink(mark, parent, index, 'close')) return '';
        const href = serializeMarkdownLinkDestination(String(mark.attrs.href ?? ''));
        const title = mark.attrs.title
          ? ` "${serializeMarkdownLinkTitle(String(mark.attrs.title))}"`
          : '';
        return `](${href}${title})`;
      },
      mixable: true,
    },
  },
);

// 表格单元格复用完整行内规则；图片属性和换行必须保持在同一条表格源码行内。
const tableCellMarkdownSerializer = new MarkdownSerializer(
  {
    ...tableMarkdownSerializer.nodes,
    paragraph(state, node, _parent, index) {
      if (index > 0) state.write('<br>');
      state.renderInline(node, false);
    },
    hard_break(state, node) {
      state.write(node.attrs.soft === true ? '<br data-nomo-break="soft">' : '<br>');
    },
    comment_inline(state, node, parent, index) {
      const content = String(node.attrs.content ?? '');
      if (content.includes('\n')) state.write(serializeHtmlInlineComment(content));
      else tableMarkdownSerializer.nodes.comment_inline(state, node, parent, index);
    },
    image(state, node, parent, index) {
      const { align, width } = node.attrs;
      const inlineImage = node.type.create({ ...node.attrs, align: null, width: null });
      tableMarkdownSerializer.nodes.image(state, inlineImage, parent, index);
      const attrs: string[] = [];
      if (align === 'left' || align === 'center' || align === 'right') attrs.push(`align=${align}`);
      if (width) attrs.push(`width=${width}`);
      if (attrs.length) state.write(`{${attrs.join(' ')}}`);
    },
    text(state, node) {
      const text = node.text ?? '';
      state.text(
        isInlineSourceText(node) ? text : escapeMarkdownTextWithoutManualInlineMarkers(text, false),
        false,
      );
    },
  },
  tableMarkdownSerializer.marks,
);

wrapSerializerNodes(tableMarkdownSerializer);
wrapSerializerNodes(tableCellMarkdownSerializer);

/**
 * 裸链接仅在文本仍是原始网址、且 mark 恰好覆盖这一个文本节点时省略括号。
 * 用户改过文本后回退为普通链接，避免保存时丢掉地址。
 */
function isBareAutoLink(
  mark: Mark,
  parent: ProseMirrorNode,
  index: number,
  side: 'open' | 'close',
): boolean {
  if (mark.attrs.auto !== true) return false;
  const nodeIndex = side === 'open' ? index : index - 1;
  if (nodeIndex < 0 || nodeIndex >= parent.childCount) return false;
  const node = parent.child(nodeIndex);
  if (!node.isText || !mark.isInSet(node.marks)) return false;
  if (bareLinkHrefForText(node.text ?? '') !== mark.attrs.href) return false;
  return (
    (nodeIndex === 0 || !mark.isInSet(parent.child(nodeIndex - 1).marks)) &&
    (nodeIndex + 1 >= parent.childCount || !mark.isInSet(parent.child(nodeIndex + 1).marks))
  );
}

function emphasisNeedsHtml(mark: Mark, parent: ProseMirrorNode, index: number): boolean {
  let from = Math.min(index, parent.childCount - 1);
  if (from >= 0 && !mark.isInSet(parent.child(from).marks)) from -= 1;
  if (from < 0) return false;

  let to = from + 1;
  while (from > 0 && mark.isInSet(parent.child(from - 1).marks)) from -= 1;
  while (to < parent.childCount && mark.isInSet(parent.child(to).marks)) to += 1;

  const first = inlineBoundaryText(parent.child(from)).match(/^[\s\S]/u)?.[0];
  const last = inlineBoundaryText(parent.child(to - 1)).match(/[\s\S]$/u)?.[0];
  const before = from > 0 ? inlineBoundaryText(parent.child(from - 1)).match(/[\s\S]$/u)?.[0] : '';
  const after = to < parent.childCount ? inlineBoundaryText(parent.child(to)).match(/^[\s\S]/u)?.[0] : '';

  // * / ** 内侧是标点、外侧紧贴文字时不满足 CommonMark 边界规则；用 HTML 保留真实格式。
  if (
    (isInlinePunctuation(first) && isInlineWordCharacter(before)) ||
    (isInlinePunctuation(last) && isInlineWordCharacter(after))
  ) {
    return true;
  }

  // 加粗回退为 HTML 时，外层斜体的星号也可能紧贴标签，需一起保持兼容。
  if (mark.type === schema.marks.em) {
    for (let i = from; i < to; i++) {
      const strong = schema.marks.strong.isInSet(parent.child(i).marks);
      if (
        strong &&
        (i === from || !strong.isInSet(parent.child(i - 1).marks)) &&
        emphasisNeedsHtml(strong, parent, i)
      ) {
        return true;
      }
    }
  }
  return false;
}

function inlineBoundaryText(node: ProseMirrorNode): string {
  if (node.type.name === 'hard_break') return '\n';
  return node.textContent || '\ufffc';
}

function isInlinePunctuation(character: string | undefined): boolean {
  return Boolean(character && /[\p{P}\p{S}]/u.test(character));
}

function isInlineWordCharacter(character: string | undefined): boolean {
  return Boolean(character && !/\s/u.test(character) && !isInlinePunctuation(character));
}

function hasFollowingInlineContent(parent: ProseMirrorNode, index: number): boolean {
  for (let i = index + 1; i < parent.childCount; i++) {
    if (parent.child(i).type.name !== 'hard_break') {
      return true;
    }
  }
  return false;
}

export function serializeMarkdown(doc: ProseMirrorNode): string {
  const state = new BufferedSerializerState(
    tableMarkdownSerializer.nodes,
    tableMarkdownSerializer.marks,
    { ...tableMarkdownSerializer.options },
  );
  state.renderContent(doc);
  return `${String(doc.attrs.frontMatterPrefix ?? '')}${state.out}`;
}

interface MarkdownSelectionExtraction {
  nodes: ProseMirrorNode[];
  fallbackToPlainText: boolean;
}
const topBlocksByDoc = new WeakMap<
  ProseMirrorNode,
  Array<{ node: ProseMirrorNode; offset: number }>
>();

/** 内容修订建立索引时预热；选区查询只查找命中的顶层块。 */
export function prepareMarkdownSelection(doc: ProseMirrorNode): void {
  if (topBlocksByDoc.has(doc)) return;
  const blocks: Array<{ node: ProseMirrorNode; offset: number }> = [];
  doc.forEach((node, offset) => blocks.push({ node, offset }));
  topBlocksByDoc.set(doc, blocks);
}

/**
 * 将语义编辑器选区转换为可独立粘贴的 Markdown。
 *
 * 完整覆盖块的可见内容时保留块结构；只覆盖块的一部分时去掉未完整选择的外层语法，
 * 六类行内格式保留实际选中的原文。局部表格无法合成完整表头，调用方只输出其文本内容。
 */
export function serializeMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): string | null {
  const selected = extractMarkdownSelection(doc, from, to);
  return selected ? serializeMarkdown(selected) : null;
}

/** 使用相同序列化规则计量，不构建大选区的整段 Markdown 字符串。 */
export function measureMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { chars: number; lines: number } | null {
  const selected = extractMarkdownSelection(doc, from, to);
  if (!selected) return null;
  type OutputState = MarkdownSerializerState & { out: string };
  // prosemirror-markdown 的状态构造器与 out 是内部 API；现有规则已使用内部 flushClose。
  const State = MarkdownSerializerState as unknown as new (
    nodes: MarkdownSerializer['nodes'],
    marks: MarkdownSerializer['marks'],
    options: MarkdownSerializerState['options'],
  ) => OutputState;
  const state = new State(tableMarkdownSerializer.nodes, tableMarkdownSerializer.marks, {
    ...tableMarkdownSerializer.options,
  });
  let chars = 0,
    breaks = 0,
    previousCR = false;
  const consume = (text: string) => {
    if (!text) return;
    chars += text.length;
    breaks +=
      (text.match(/\r\n|\r|\n/g) ?? []).length - (previousCR && text.startsWith('\n') ? 1 : 0);
    previousCR = text.endsWith('\r');
  };
  consume(String(selected.attrs.frontMatterPrefix ?? ''));
  selected.forEach((node, _offset, index) => {
    state.render(node, selected, index);
    // 规则只检查输出尾部的换行，以及链接前的 !／\\!。保留两个字符和 closed 状态，
    // 后续块的分隔语义不变；atBlank 等规则不会反复扫描已经输出的所有块。
    if (state.out.length > 2) {
      consume(state.out.slice(0, -2));
      state.out = state.out.slice(-2);
    }
  });
  consume(state.out);
  return { chars, lines: breaks + 1 };
}

function extractMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ProseMirrorNode | null {
  if (from < 0 || to > doc.content.size || from >= to) {
    return null;
  }

  const listTextblock = extractSingleListTextblockSelection(doc, from, to);
  if (listTextblock) {
    return schema.nodes.doc.create(null, listTextblock);
  }

  const extraction: MarkdownSelectionExtraction = {
    nodes: [],
    fallbackToPlainText: false,
  };
  prepareMarkdownSelection(doc);
  const blocks = topBlocksByDoc.get(doc)!;
  let lo = 0,
    hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid].offset + blocks[mid].node.nodeSize <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < blocks.length && blocks[i].offset < to; i++) {
    appendSelectedMarkdownNodes(extraction, blocks[i].node, blocks[i].offset, from, to);
  }

  if (extraction.fallbackToPlainText || extraction.nodes.length === 0) {
    return null;
  }

  return schema.nodes.doc.create(null, extraction.nodes);
}

/**
 * 列表序号和项目符号属于外层列表结构，不是正文里的可选字符。
 * 当选区始终位于同一个列表正文块时，只复制该正文块，避免完整选中文字后补回未选中的列表标记。
 */
function extractSingleListTextblockSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ProseMirrorNode | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock || !isInsideListItem($from)) {
    return null;
  }

  const textblock = $from.parent;
  const contentFrom = $from.start($from.depth);
  const contentTo = $from.end($from.depth);
  if (from <= contentFrom && to >= contentTo) {
    return textblock;
  }

  const localFrom = Math.max(0, from - contentFrom);
  const localTo = Math.min(textblock.content.size, to - contentFrom);
  if (localFrom >= localTo) {
    return null;
  }

  return schema.nodes.paragraph.create(null, textblock.content.cut(localFrom, localTo));
}

function isInsideListItem($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth - 1; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === schema.nodes.list_item) {
      return true;
    }
  }
  return false;
}

function appendSelectedMarkdownNodes(
  extraction: MarkdownSelectionExtraction,
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  if (!selectionIntersectsNode(node, pos, from, to)) {
    return;
  }

  const fullySelected = selectionCoversVisibleNodeContent(node, pos, from, to);
  if (node.type === schema.nodes.table) {
    if (fullySelected) {
      extraction.nodes.push(node);
    } else {
      extraction.fallbackToPlainText = true;
    }
    return;
  }

  if (fullySelected) {
    extraction.nodes.push(node);
    return;
  }

  if (node.isTextblock) {
    appendPartialTextblock(extraction, node, pos, from, to);
    return;
  }

  if (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list) {
    appendPartialList(extraction, node, pos, from, to);
    return;
  }

  node.forEach((child, offset) => {
    appendSelectedMarkdownNodes(extraction, child, pos + 1 + offset, from, to);
  });
}

function appendPartialTextblock(
  extraction: MarkdownSelectionExtraction,
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  const contentFrom = pos + 1;
  const localFrom = Math.max(0, from - contentFrom);
  const localTo = Math.min(node.content.size, to - contentFrom);
  if (localFrom >= localTo) {
    return;
  }

  extraction.nodes.push(schema.nodes.paragraph.create(null, node.content.cut(localFrom, localTo)));
}

function appendPartialList(
  extraction: MarkdownSelectionExtraction,
  list: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  let selectedItems: ProseMirrorNode[] = [];
  let selectedItemsStartIndex = 0;

  const flushSelectedItems = () => {
    if (selectedItems.length === 0) {
      return;
    }

    const attrs =
      list.type === schema.nodes.ordered_list
        ? {
            ...list.attrs,
            order: Number(list.attrs.order ?? 1) + selectedItemsStartIndex,
          }
        : list.attrs;
    extraction.nodes.push(list.type.create(attrs, selectedItems));
    selectedItems = [];
  };

  list.forEach((item, offset, index) => {
    const itemPos = pos + 1 + offset;
    if (!selectionIntersectsNode(item, itemPos, from, to)) {
      return;
    }

    if (selectionCoversVisibleNodeContent(item, itemPos, from, to)) {
      if (selectedItems.length === 0) {
        selectedItemsStartIndex = index;
      }
      selectedItems.push(item);
      return;
    }

    flushSelectedItems();
    appendSelectedMarkdownNodes(extraction, item, itemPos, from, to);
  });

  flushSelectedItems();
}

function selectionIntersectsNode(node: ProseMirrorNode, pos: number, from: number, to: number) {
  return from < pos + node.nodeSize && to > pos;
}

function selectionCoversVisibleNodeContent(
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  const bounds = getVisibleNodeContentBounds(node, pos);
  return from <= bounds.from && to >= bounds.to;
}

function getVisibleNodeContentBounds(
  node: ProseMirrorNode,
  pos: number,
): { from: number; to: number } {
  if (node.isTextblock) {
    return {
      from: pos + 1,
      to: pos + 1 + node.content.size,
    };
  }

  if (node.isLeaf || node.childCount === 0) {
    return {
      from: pos,
      to: pos + node.nodeSize,
    };
  }

  const firstChild = node.child(0);
  const lastChild = node.child(node.childCount - 1);
  const firstBounds = getVisibleNodeContentBounds(firstChild, pos + 1);
  const lastChildPos = pos + 1 + node.content.size - lastChild.nodeSize;
  const lastBounds = getVisibleNodeContentBounds(lastChild, lastChildPos);
  return {
    from: firstBounds.from,
    to: lastBounds.to,
  };
}

function flushPendingClosedBlock(state: unknown): void {
  (state as { flushClose(): void }).flushClose();
}

function serializeTable(table: ProseMirrorNode): string {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  if (rows.length === 0) return '';
  if (requiresHtmlTable(rows)) return serializeHtmlTable(table);

  const columnCount = Math.max(...rows.map((row) => row.childCount));
  const serializedRows = rows.map((row) => serializeTableRow(row, columnCount));
  const alignments = Array.from({ length: columnCount }, (_, index) =>
    readColumnAlignment(rows, index),
  );
  const separator = alignments.map((align) => {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return ':---';
  });

  return [serializedRows[0], separator, ...serializedRows.slice(1)]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

/** GFM 只表示单层矩形、首行表头和逐列统一对齐；其它语义保留 HTML。 */
function requiresHtmlTable(rows: ProseMirrorNode[]): boolean {
  const width = rows[0].childCount;
  return rows.some((row, rowIndex) => {
    if (row.childCount !== width) return true;
    for (let column = 0; column < row.childCount; column += 1) {
      const cell = row.child(column);
      const expectedType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
      if (
        cell.type !== expectedType || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 ||
        cell.attrs.colwidth !== null || cell.childCount !== 1 ||
        cell.attrs.align !== rows[0].child(column).attrs.align
      ) return true;
    }
    return false;
  });
}

function serializeHtmlTable(table: ProseMirrorNode): string {
  const rows: string[] = [];
  projectInlineSource(table).forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      const tag = cell.type === schema.nodes.table_header ? 'th' : 'td';
      const attrs: string[] = [];
      for (const name of ['colspan', 'rowspan']) {
        if (cell.attrs[name] !== 1) attrs.push(name + '="' + escapeHtmlAttr(String(cell.attrs[name])) + '"');
      }
      if (cell.attrs.colwidth !== null) {
        attrs.push('data-colwidth="' + escapeHtmlAttr(cell.attrs.colwidth.join(',')) + '"');
      }
      if (cell.attrs.align !== null) attrs.push('data-align="' + escapeHtmlAttr(cell.attrs.align) + '"');
      const paragraphs: string[] = [];
      cell.forEach((paragraph) => paragraphs.push('<p>' + serializeHtmlInlineContent(paragraph) + '</p>'));
      cells.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + paragraphs.join('') + '</' + tag + '>');
    });
    rows.push('<tr>' + cells.join('') + '</tr>');
  });
  // 单行块让引用/列表/Callout 的 Markdown 前缀保持在表格外，正文换行使用行内 codec。
  return '<table data-nomo-table="semantic"><tbody>' + rows.join('') + '</tbody></table>';
}

function serializeTableRow(row: ProseMirrorNode, columnCount: number): string[] {
  const cells: string[] = [];
  row.forEach((cell) => cells.push(serializeTableCell(cell)));
  while (cells.length < columnCount) cells.push('');
  return cells;
}

/** 标记内部的 `|` 属于指令语法，不能按表格列分隔符转义。 */
function escapeTablePipes(text: string): string {
  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '[' || text[index + 1] !== '[') {
      index += 1;
      continue;
    }
    const end = text.indexOf(']]', index + 2);
    if (end < 0) break;
    const marker = parseInlineMarker(text.slice(index + 2, end));
    if (!marker) {
      index += 2;
      continue;
    }
    output += text.slice(cursor, index).replace(/\|/g, '\\|');
    output += text.slice(index, end + 2);
    index = end + 2;
    cursor = index;
  }
  output += text.slice(cursor).replace(/\|/g, '\\|');
  return output;
}

function serializeTableCell(cell: ProseMirrorNode): string {
  // 表格分隔符只在最终输出时转义，不能删除正文或代码中的反斜杠。
  return escapeTablePipes(tableCellMarkdownSerializer.serialize(cell).replace(/\n/g, ' ')).trim();
}

function splitTaskParagraph(
  node: ProseMirrorNode,
): { marker: string; content: ProseMirrorNode } | null {
  const firstChild = node.firstChild;
  const marker = readTaskListMarker(node);
  if (!marker || !firstChild) return null;

  const children: ProseMirrorNode[] = [];
  const restText = (firstChild.text ?? '').slice(marker.text.length);
  if (restText) children.push(node.type.schema.text(restText, firstChild.marks));
  for (let index = 1; index < node.childCount; index++) {
    children.push(node.child(index));
  }

  return {
    marker: marker.text.endsWith(' ') ? marker.text : `${marker.text} `,
    content: node.type.create(node.attrs, Fragment.fromArray(children), node.marks),
  };
}

function escapeMarkdownTextWithoutManualInlineMarkers(text: string, escapePipes = true): string {
  let escaped = text.replace(escapePipes ? /[`\\[\]|_]/g : /[`\\[\]_]/g, (match, index) =>
    match === '_' &&
    index > 0 &&
    index + 1 < text.length &&
    /\w/.test(text[index - 1] ?? '') &&
    /\w/.test(text[index + 1] ?? '')
      ? match
      : `\\${match}`,
  );

  if (/(?:\*{1,3})(?=\S)[\s\S]*?\S\*{1,3}/.test(escaped)) {
    escaped = escaped.replace(/(?<!\\)\*/g, '\\*');
  }
  if (/~~(?=\S)[\s\S]*?\S~~/.test(escaped)) {
    escaped = escaped.replace(/(?<!\\)~/g, '\\~');
  }
  if (/\$\$(?:[\s\S]*?\S)?\$\$|\$(?!\$)(?=\S)[^\n]*?\S\$(?!\$)/.test(escaped)) {
    escaped = escaped.replace(/(?<!\\)\$/g, '\\$');
  }
  escaped = escaped.replace(/(?<!\\)<(?=\/?[A-Za-z][^>]*>)/g, '\\<');
  return escaped;
}

/**
 * 需要在渲染后逐行修正的段落：缩进、行首块级语法、硬换行或行内代码。
 *
 * 不满足这些条件时，后处理是恒等变换；但后处理会 `slice` 整个输出串再拼回，
 * 在大文档上是平方级开销（论文约 150 ms），因此先判断能否直接跳过。
 */
const PARAGRAPH_REWRITE_REQUIRED = new RegExp(
  [
    '^[ \\t]+(?=\\S)',
    '^(?:\\s{0,3})(?:#{1,6}(?:\\s|$)|>(?:\\s|$)|[-+*](?:\\s|$)|\\d+[.)](?:\\s|$)',
    '|`{3,}(?=[^`]*$)|~{3,}|(?:[-*_]\\s*){3,}$|=+\\s*$)',
  ].join('|'),
  'm',
);

function paragraphNeedsInlineRewrite(node: ProseMirrorNode): boolean {
  const text = node.textBetween(0, node.content.size, '\n', '\n');
  if (text.includes('\n') || PARAGRAPH_REWRITE_REQUIRED.test(text)) return true;
  // 行内代码跨行时，行首保护必须让位给代码片段。
  let hasCodeMark = false;
  node.forEach((child) => {
    if (!hasCodeMark && child.isText && child.marks.some((mark) => mark.type === schema.marks.code)) {
      hasCodeMark = true;
    }
  });
  return hasCodeMark;
}

function renderParagraphInline(state: MarkdownSerializerState, node: ProseMirrorNode): void {
  // 先输出容器的列表/引用前缀，只保护段落正文，不能把真实容器语法转成字面文本。
  state.write();
  if (!paragraphNeedsInlineRewrite(node)) {
    state.renderInline(node);
    return;
  }
  const output = state as unknown as { out: string; delim: string };
  // 独立缓冲区：整篇输出不再逐段 slice + 拼回（那是另一个平方级开销）。
  const buffered = state instanceof BufferedSerializerState ? state : null;
  const snapshot = buffered?.suspendOutput() ?? null;
  const from = buffered ? 0 : output.out.length;
  const syntaxRanges: Array<{ from: number; to: number }> = [];
  paragraphSyntaxRanges.set(state, syntaxRanges);
  try {
    state.renderInline(node);
  } finally {
    // out 修正后旧绝对坐标失效；范围只属于这一段，不能影响之后的图片或段落。
    paragraphSyntaxRanges.delete(state);
  }
  const source = buffered && snapshot ? buffered.resumeOutput(snapshot) : output.out.slice(from);
  // 只有行内代码区间需要保护行首；没有反引号就不必跑一遍 markdown-it。
  if (source.includes('`')) {
    for (const span of analyzeInlineSourceText(source).spans) {
      if (span.type === 'code') syntaxRanges.push({ from: from + span.openFrom, to: from + span.closeTo });
    }
  }
  let offset = from;
  const content = source.split('\n').map((line, index) => {
    const prefix = index > 0 && line.startsWith(output.delim) ? output.delim : '';
    const body = line.slice(prefix.length);
    const start = offset + prefix.length;
    offset += line.length + 1;
    if (syntaxRanges.some((range) => start >= range.from && start < range.to)) return line;
    // Markdown 会裁掉段首空白或把四列缩进解释为代码；实体保留真实空格与 Tab。
    const indentation = /^[ \t]+(?=\S)/.exec(body)?.[0];
    if (indentation) {
      const literalIndentation = indentation.replace(/ /g, '&#32;').replace(/\t/g, '&#9;');
      return prefix + literalIndentation + body.slice(indentation.length);
    }
    return prefix + escapeMarkdownBlockStart(body);
  }).join('\n');
  if (buffered) buffered.appendRaw(content);
  else output.out = output.out.slice(0, from) + content;
}

function escapeMarkdownBlockStart(text: string): string {
  return text.replace(
    /^(\s{0,3})(#{1,6}(?:\s|$)|>(?:\s|$)|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}(?=[^`]*$)|~{3,}|(?:[-*_]\s*){3,}$|=+\s*$)/,
    (_match, indentation: string, marker: string) =>
      /^\d+[.)]/.test(marker)
        ? `${indentation}${marker.replace(/[.)]/, '\\$&')}`
        : `${indentation}\\${marker}`,
  );
}

function containsLiteralDisplayMathSyntax(parent: ProseMirrorNode): boolean {
  if (!parent.isTextblock || parent.type === schema.nodes.code_block) return false;
  const text = parent.textBetween(0, parent.content.size, '\n', '\n').trim();
  return /^\$\$[\s\S]*\$\$$/.test(text) && text.length > 2;
}

function readColumnAlignment(
  rows: ProseMirrorNode[],
  columnIndex: number,
): TableColumnAlignment | null {
  for (const row of rows) {
    if (columnIndex >= row.childCount) continue;
    const cell = row.child(columnIndex);
    const align = cell?.attrs.align;
    if (align === 'left' || align === 'center' || align === 'right') return align;
  }
  return null;
}

function serializeMarkdownComment(content: string, block: boolean): string {
  const safeContent = content.replace(/-->/g, '-- >').replace(/\r\n/g, '\n');
  if (block) {
    return `<!--\n${safeContent}\n-->`;
  }

  return safeContent ? `<!-- ${safeContent} -->` : '<!---->';
}

function serializeHtmlInlineComment(content: string): string {
  const safeContent = content.replace(/-->/g, '-- >').replace(/\r\n/g, '\n');
  const attribute = escapeHtmlAttr(safeContent).replace(/\|/g, '&#124;');
  return `<span class="comment-inline" data-comment="${attribute}"></span>`;
}

export function serializeClipboardText(slice: Slice, preserveInlineSource = false): string {
  let text = '';
  let hasBlock = false;
  let previousBlockWasEmptyParagraph = false;

  const inline = slice.content.firstChild?.isInline === true;
  const input = schema.nodes.doc.create(null, inline
    ? schema.nodes.paragraph.create(null, slice.content) : slice.content);
  const projected = preserveInlineSource ? input : projectInlineSource(input);
  const content = inline ? projected.firstChild!.content : projected.content;
  content.nodesBetween(0, content.size, (node) => {
    const nodeText = node.isText
      ? (node.text ?? '')
      : node.type.name === 'hard_break'
        ? '\n'
        : node.isLeaf
          ? (node.type.spec.leafText?.(node) ?? '')
          : '';

    if (node.isBlock && ((node.isLeaf && nodeText) || node.isTextblock)) {
      if (hasBlock) {
        text += previousBlockWasEmptyParagraph ? '\n' : '\n\n';
      }
      hasBlock = true;
      previousBlockWasEmptyParagraph =
        node.type === schema.nodes.paragraph && node.content.size === 0;
    }

    text += nodeText;
  });

  return text;
}
