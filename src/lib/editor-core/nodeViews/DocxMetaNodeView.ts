import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  DOCX_META_KIND_LABELS,
  summarizeDirectiveLines,
} from '../../docxmd/metaSummary';

/**
 * `.docx.md` 结构指令的隐藏载体。
 *
 * 默认零高度、不可编辑；结构类指令显示一行摘要（分节/页面/页眉页脚/目录），
 * 打开“显示指令”调试开关后显示原始行。原始行始终写进 DOM 的
 * `data-docx-line`，复制/查找不会得到伪内容。
 */
const ACTIVATABLE_KINDS = new Set([
  'section',
  'page',
  'headerFooter',
  'toc',
  'separator',
  // 片段/形状/对象/导入无法在正文中完整预览，至少给出可点击的中性标记。
  'snippet',
  'shape',
  'object',
  'import',
]);

export class DocxMetaNodeView {
  dom: HTMLElement;

  private node: ProseMirrorNode;
  private clickable = false;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined = () => undefined,
    private readonly onActivate?: (blockIndex: number) => void,
  ) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'docx-meta';
    this.dom.contentEditable = 'false';
    this.render();
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.clickable && (event.type === 'mousedown' || event.type === 'click' || event.type === 'keydown');
  }

  /** 结构标记不进入正文选区，只把属性面板锁定到对应元信息块。 */
  private activate(): void {
    if (!this.onActivate) return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    const { doc } = this.view.state;
    if (pos < 0 || pos > doc.content.size) return;
    this.onActivate(doc.resolve(pos).index(0));
  }

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.clickable) return;
    event.preventDefault();
    this.dom.focus();
  };

  private handleClick = (event: MouseEvent): void => {
    if (!this.clickable) return;
    event.preventDefault();
    this.activate();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.clickable) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.activate();
  };

  private setClickable(clickable: boolean, label: string): void {
    const next = clickable && Boolean(this.onActivate);
    if (next !== this.clickable) {
      this.clickable = next;
      if (next) {
        this.dom.addEventListener('mousedown', this.handleMouseDown);
        this.dom.addEventListener('click', this.handleClick);
        this.dom.addEventListener('keydown', this.handleKeyDown);
        this.dom.tabIndex = 0;
        this.dom.setAttribute('role', 'button');
        this.dom.dataset.docxActivatable = 'true';
      } else {
        this.dom.removeEventListener('mousedown', this.handleMouseDown);
        this.dom.removeEventListener('click', this.handleClick);
        this.dom.removeEventListener('keydown', this.handleKeyDown);
        this.dom.removeAttribute('tabindex');
        this.dom.removeAttribute('role');
        delete this.dom.dataset.docxActivatable;
      }
    }
    if (this.clickable) {
      this.dom.title = label ? `编辑结构属性：${label}` : '编辑结构属性';
      this.dom.setAttribute('aria-label', this.dom.title);
    } else {
      this.dom.removeAttribute('title');
      this.dom.removeAttribute('aria-label');
    }
  }

  private render(): void {
    const kind = String(this.node.attrs.metaKind ?? 'mixed');
    const lines = Array.isArray(this.node.attrs.rawLines) ? this.node.attrs.rawLines : [];
    const sectionIndex = Number(this.node.attrs.sectionIndex) || null;
    this.dom.dataset.docxKind = kind;
    this.dom.dataset.docxLines = String(lines.length);
    if (sectionIndex) this.dom.dataset.docxSection = String(sectionIndex);
    else delete this.dom.dataset.docxSection;

    const badge = document.createElement('span');
    badge.className = 'docx-meta-badge';
    badge.textContent = DOCX_META_KIND_LABELS[kind] ?? DOCX_META_KIND_LABELS.mixed!;

    const summaryText = summarizeDirectiveLines(kind, lines, sectionIndex);
    const summary = document.createElement('span');
    summary.className = 'docx-meta-summary';
    summary.textContent = summaryText;
    if (summaryText) summary.title = summaryText;

    this.setClickable(ACTIVATABLE_KINDS.has(kind), [badge.textContent, summaryText].filter(Boolean).join(' · '));

    const list = document.createElement('div');
    list.className = 'docx-meta-lines';
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'docx-meta-line';
      row.dataset.docxLine = String(line);
      row.textContent = String(line);
      list.appendChild(row);
    }

    this.dom.replaceChildren(badge, summary, list);
  }
}
