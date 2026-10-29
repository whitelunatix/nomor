import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { schema } from '../../../lib/editor-core/schema';
import { parseMarkdown, tryParseMarkdown } from '../../../lib/editor-core/markdown';
import { projectInlineSource } from '../../../lib/editor-core/InlineSourceCodec';
import { removeEmptyTrailingParagraph } from '../../../lib/editor-core/plugins/trailingParagraph';
import { renderHtmlPreview, sanitizeHtml } from '../../../lib/editor-core/utils/html';
import { extractDocumentTocItems } from '../../../lib/toc/tocService';
import { getCalloutConfig } from '../../../lib/editor-core/callout/calloutTypes';
import { getCalloutIconSvg } from '../../../lib/editor-core/callout/calloutIcons';
import { getCodeLanguageLabel } from '../../../lib/editor-core/codeLanguages';
import { createShikiCodeTokenizer } from '../../../lib/services/shikiCodeTokenizer';
import { createKatexMathRenderer } from '../../../lib/services/katexMathRenderer';
import { createMermaidDiagramRenderer } from '../../../lib/services/mermaidDiagramRenderer';
import type { CodeTokenLine } from '../../../lib/services/render';
import { awaitExport, throwIfExportAborted, type ExportSnapshot, type ExportTaskOptions } from './types';

/** 同步解析快照，异步增强只操作本次独立 DOM；不触发编辑器挂载、选区或滚动。 */
export async function renderExportBody(snapshot: ExportSnapshot, options: ExportTaskOptions = {}) {
  throwIfExportAborted(options.signal);
  const parsed = tryParseMarkdown(snapshot.markdown, { exportImageSources: true });
  const source = parsed ?? parseMarkdown(snapshot.markdown);
  const warnings: string[] = parsed ? [] : ['部分 Markdown 无法解析，已保留原始文本'];
  const headings = extractDocumentTocItems(source);
  const doc = projectInlineSource(removeEmptyTrailingParagraph(source));
  const nodes = DOMSerializer.nodesFromSchema(schema);
  const jobs: Array<{ type: string; node: ProseMirrorNode; element: HTMLElement }> = [];
  const element = (tag: string, className: string, text?: string) => {
    const result = document.createElement(tag);
    result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  let headingIndex = 0;
  nodes.heading = node => {
    const heading = document.createElement(`h${node.attrs.level}`);
    const item = headings[headingIndex++];
    heading.id = item?.id ?? '';
    if (item) heading.dataset.nomoHeadingTitle = item.title;
    return { dom: heading, contentDOM: heading };
  };
  for (const type of ['code_block', 'mermaid_block', 'math_block', 'math_inline']) {
    nodes[type] = node => {
      const target = element(type === 'math_inline' ? 'span' : 'div', {
        code_block: 'code-card', mermaid_block: 'mermaid-block', math_block: 'math-block', math_inline: 'math-inline',
      }[type]!);
      jobs.push({ type, node, element: target });
      return target;
    };
  }
  nodes.callout = node => {
    const config = getCalloutConfig(String(node.attrs.type));
    const card = element('div', 'callout-card');
    card.dataset.calloutType = config.type;
    const header = element('div', 'callout-header');
    const icon = element('span', 'callout-icon');
    icon.innerHTML = getCalloutIconSvg(config.icon);
    header.append(icon, element('span', 'callout-title', snapshot.appearance.labels[config.type]));
    const body = element('div', 'callout-body');
    card.append(header, body);
    return { dom: card, contentDOM: body };
  };
  nodes.toc_block = () => {
    const section = element('section', 'toc-block');
    const header = document.createElement('header');
    header.append(element('strong', '', snapshot.appearance.labels.toc));
    section.append(header);
    if (!headings.length) section.append(element('p', 'toc-empty', snapshot.appearance.labels.emptyToc));
    const list = element('nav', 'toc-list');
    for (const [index, item] of headings.entries()) {
      const link = element('a', 'toc-link') as HTMLAnchorElement;
      link.href = `#${encodeURIComponent(item.id)}`;
      link.dataset.level = String(item.level);
      link.style.setProperty('--toc-indent', `${(item.level - 1) * 28}px`);
      link.append(element('span', 'toc-bullet'), element('span', 'toc-text', item.title),
        element('span', 'toc-leader'), element('span', 'toc-page', String(index + 1)));
      list.append(link);
    }
    section.append(list);
    return section;
  };
  const footnoteCounts = new Map<string, number>();
  nodes.footnote_ref = node => {
    const id = encodeURIComponent(String(node.attrs.id));
    const count = (footnoteCounts.get(id) ?? 0) + 1;
    footnoteCounts.set(id, count);
    const ref = element('sup', 'footnote-ref', String(node.attrs.id));
    ref.id = `nomo-fnref-${id}-${count}`;
    const link = document.createElement('a');
    link.href = `#${encodeURIComponent(`nomo-fn-${id}`)}`;
    link.append(...ref.childNodes);
    ref.append(link);
    return ref;
  };
  nodes.footnote_def = node => {
    const id = encodeURIComponent(String(node.attrs.id));
    const definition = element('div', 'footnote-def');
    definition.id = `nomo-fn-${id}`;
    const marker = element('a', 'footnote-def-marker', String(node.attrs.id)) as HTMLAnchorElement;
    marker.href = `#${encodeURIComponent(`nomo-fnref-${id}-1`)}`;
    const body = element('span', 'footnote-def-content');
    definition.append(marker, body);
    return { dom: definition, contentDOM: body };
  };
  const root = document.createElement('div');
  root.append(new DOMSerializer(nodes, DOMSerializer.marksFromSchema(schema)).serializeFragment(doc.content));
  // 与编辑器的只读 HTML 回退策略一致；行内代码仍按字面文本输出。
  root.querySelectorAll('p').forEach(paragraph => {
    if ([...paragraph.childNodes].every(node => node.nodeType === Node.TEXT_NODE) && /^\s*<\w+[\s>]/.test(paragraph.textContent ?? '')) {
      const fallback = document.createElement('div');
      fallback.className = 'html-widget';
      renderHtmlPreview(fallback, sanitizeHtml(paragraph.textContent ?? ''));
      paragraph.replaceWith(fallback);
    }
  });
  // HTML 回退也可能携带徽章；在图片内嵌改写地址前统一记录其展示类型。
  root.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    if (/https?:\/\/(?:img\.shields\.io|badgen\.net)\//i.test(image.getAttribute('src') ?? '')) image.dataset.nomoBadge = '';
  });
  root.querySelectorAll<HTMLElement>('li > p:first-child').forEach(paragraph => {
    const first = paragraph.firstChild;
    if (first?.nodeType !== Node.TEXT_NODE) return;
    const marker = /^(\[[ xX]\])(?:[ \t]|$)/.exec(first.textContent ?? '');
    if (!marker) return;
    first.textContent = first.textContent!.slice(marker[0].length);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = true;
    if (/x/i.test(marker[1])) checkbox.setAttribute('checked', '');
    const widget = element('span', 'task-checkbox-widget');
    widget.append(checkbox);
    paragraph.prepend(widget);
  });
  const tokenizer = createShikiCodeTokenizer({ cacheBytes: 0 });
  const math = createKatexMathRenderer();
  const diagram = createMermaidDiagramRenderer();
  // 顺序增强不为全文同时创建高亮/图表任务；Mermaid 仍复用全局串行主题队列。
  for (const job of jobs) {
    throwIfExportAborted(options.signal);
    const { node, element: target } = job;
    const text = String(job.type === 'code_block' ? node.textContent : node.attrs.code ?? node.attrs.tex ?? '');
    try {
      if (job.type === 'code_block') {
        const language = String(node.attrs.params ?? '').trim().split(/\s+/)[0];
        target.append(element('header', '', getCodeLanguageLabel(language)));
        const pre = element('pre', 'export-code');
        const code = document.createElement('code');
        pre.append(code);
        target.append(pre);
        let lines: CodeTokenLine[];
        try {
          // 与编辑器展示层一样避免超长代码高亮阻塞主线程；正文仍完整输出。
          if (text.length > 80_000) throw new Error('代码超过高亮预算');
          lines = (await awaitExport(tokenizer.tokenize({ code: text, language, theme: snapshot.appearance.shikiTheme }), options.signal)).tokens;
        }
        catch (error) {
          throwIfExportAborted(options.signal);
          warnings.push(`代码高亮失败，已保留纯文本：${String(error)}`);
          lines = text.split('\n').map(line => ({ tokens: [{ content: line }] }));
        }
        for (const [index, line] of lines.entries()) {
          const row = element('span', 'code-line');
          if (language === 'diff') {
            const prefix = line.tokens.map(token => token.content).join('').charAt(0);
            if (prefix === '+') row.classList.add('diff-added');
            if (prefix === '-') row.classList.add('diff-removed');
          }
          row.dataset.line = String(index + 1);
          const content = element('span', 'line-content');
          for (const token of line.tokens) {
            const span = element('span', '', token.content);
            if ('color' in token && token.color) span.style.color = token.color;
            if ('fontStyle' in token) {
              const flags = Number(token.fontStyle);
              if (flags & 1) span.style.fontStyle = 'italic';
              if (flags & 2) span.style.fontWeight = '700';
              if (flags & 4) span.style.textDecoration = 'underline';
            }
            content.append(span);
          }
          if (index < lines.length - 1) content.append(document.createTextNode('\n'));
          row.append(content);
          code.append(row);
        }
      } else if (job.type === 'mermaid_block') {
        const controller = new AbortController();
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          const result = await awaitExport(diagram.renderMermaid(text, { theme: snapshot.appearance.mermaid, signal: controller.signal }), options.signal);
          if (result.error || !result.svg) throw new Error(result.error || '图表为空');
          const content = element('div', 'mermaid-block-rendered');
          content.innerHTML = result.svg;
          target.append(content);
        } finally { controller.abort(); options.signal?.removeEventListener('abort', abort); }
      } else {
        const result = await awaitExport(math.render(text, { displayMode: job.type === 'math_block' }), options.signal);
        if (result.error || !result.html || result.html.includes('class="katex-error"')) throw new Error(result.error || '公式语法错误');
        target.innerHTML = result.html;
      }
    } catch (error) {
      throwIfExportAborted(options.signal);
      const message = `${job.type === 'mermaid_block' ? '图表' : job.type === 'code_block' ? '代码' : '公式'}渲染失败：${error instanceof Error ? error.message : String(error)}`;
      target.replaceChildren(element(job.type === 'math_inline' ? 'span' : 'pre', 'nomo-export-source', text), element('span', 'nomo-render-error', message));
      warnings.push(message);
    }
  }
  return { html: root.innerHTML, warnings };
}
