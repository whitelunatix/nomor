import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { t } from '../../../app/i18n';
import { commitActiveEdit, isActiveEditComposing } from '../nodeViews/activeEditRegistry';
import { isInlineSourceComposing } from './inlineSourceEditing';

const GUTTER_WIDTH = 20;
const GUTTER_GAP = 4;
const HANDLE_HEIGHT = 24;

type PointerPosition = { x: number; y: number };
type ParagraphTarget = {
  element: HTMLElement;
  heading: boolean;
  rect: DOMRect;
};

/** 正文外侧的整段选择入口；浮层不进入文档，仅支持顶层段落与标题。 */
export function paragraphSelectionGutterPlugin(): Plugin {
  return new Plugin({
    view(view) {
      return new ParagraphSelectionGutterView(view);
    },
  });
}

class ParagraphSelectionGutterView {
  private readonly dom: HTMLButtonElement;
  private readonly host: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly resizeObserver: ResizeObserver | null;
  private pointer: PointerPosition | null = null;
  private frame = 0;

  constructor(private readonly view: EditorView) {
    this.host = view.dom.parentElement ?? view.dom;
    this.pane = this.host.closest<HTMLElement>('.semantic-pane') ?? this.host;
    this.dom = view.dom.ownerDocument.createElement('button');
    this.dom.type = 'button';
    this.dom.className = 'paragraph-selection-gutter';
    this.dom.contentEditable = 'false';
    // 鼠标辅助入口不增加逐段 Tab 停靠点，正文仍使用既有键盘选区操作。
    this.dom.tabIndex = -1;
    this.dom.hidden = true;
    this.host.appendChild(this.dom);

    this.pane.addEventListener('pointermove', this.handlePointerMove);
    this.pane.addEventListener('pointerdown', this.handlePointerDown);
    this.pane.addEventListener('pointerleave', this.clear);
    this.pane.addEventListener('pointercancel', this.clear);
    this.pane.addEventListener('scroll', this.clear, true);
    this.dom.addEventListener('click', this.handleClick);
    window.addEventListener('blur', this.clear);
    window.addEventListener('resize', this.clear);
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.clear);
    this.resizeObserver?.observe(this.host);
  }

  update(): void {
    if (this.pointer) this.schedule();
  }

  destroy(): void {
    this.clear();
    this.resizeObserver?.disconnect();
    this.pane.removeEventListener('pointermove', this.handlePointerMove);
    this.pane.removeEventListener('pointerdown', this.handlePointerDown);
    this.pane.removeEventListener('pointerleave', this.clear);
    this.pane.removeEventListener('pointercancel', this.clear);
    this.pane.removeEventListener('scroll', this.clear, true);
    this.dom.removeEventListener('click', this.handleClick);
    window.removeEventListener('blur', this.clear);
    window.removeEventListener('resize', this.clear);
    this.dom.remove();
  }

  private readonly clear = (): void => {
    this.pointer = null;
    this.dom.hidden = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  private acceptsPointer(event: PointerEvent): boolean {
    return (
      (!event.pointerType || event.pointerType === 'mouse') &&
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    );
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    // 拖选、分栏调整、触摸和带修饰键的操作继续交给原来的交互。
    if (!this.acceptsPointer(event) || event.buttons !== 0) {
      this.clear();
      return;
    }
    this.pointer = { x: event.clientX, y: event.clientY };
    this.schedule();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || !this.acceptsPointer(event)) return;
    const pointer = { x: event.clientX, y: event.clientY };
    const target = this.findTarget(pointer);
    if (!target) return;

    // 阻止边栏点击触发原生光标定位；每次按下重新命中，避免使用过期节点位置。
    event.preventDefault();
    this.pointer = pointer;
    this.select(target);
    this.schedule();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    event.preventDefault();
    // 兼容辅助技术触发的按钮点击；鼠标选择已在 pointerdown 完成。
    if (event.detail === 0 && this.pointer) {
      const target = this.findTarget(this.pointer);
      if (target) this.select(target);
    }
  };

  private select(target: ParagraphTarget): void {
    // 原生公式／代码输入退出时可能提交内容或恢复光标，先收束再定位最终选区。
    commitActiveEdit(this.view, true);
    this.view.focus();
    if (target.element.parentElement !== this.view.dom) return;
    const $from = this.view.state.doc.resolve(this.view.posAtDOM(target.element, 0));
    if (
      $from.depth !== 1 || $from.parent.content.size === 0 ||
      !['paragraph', 'heading'].includes($from.parent.type.name)
    ) return;
    this.view.dispatch(
      this.view.state.tr
        .setSelection(TextSelection.create(this.view.state.doc, $from.start(), $from.end()))
        .setMeta('addToHistory', false),
    );
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const target = this.pointer && this.findTarget(this.pointer);
      if (!target || !this.pointer) {
        this.clear();
        return;
      }

      const hostRect = this.host.getBoundingClientRect();
      const viewRect = this.view.dom.getBoundingClientRect();
      const scale = this.getScale();
      const height = Math.min(HANDLE_HEIGHT, target.rect.height / scale.y);
      const center = Math.max(
        target.rect.top + height * scale.y / 2,
        Math.min(this.pointer.y, target.rect.bottom - height * scale.y / 2),
      );
      this.dom.style.left = `${(viewRect.left - hostRect.left) / scale.x - GUTTER_GAP - GUTTER_WIDTH}px`;
      this.dom.style.top = `${(center - hostRect.top) / scale.y - height / 2}px`;
      this.dom.style.height = `${height}px`;
      this.dom.setAttribute('aria-label', t[target.heading ? 'selectWholeHeading' : 'selectWholeParagraph']());
      this.dom.hidden = false;
    });
  }

  private getScale(): { x: number; y: number } {
    const rect = this.host.getBoundingClientRect();
    return {
      x: rect.width > 0 && this.host.offsetWidth > 0 ? rect.width / this.host.offsetWidth : 1,
      y: rect.height > 0 && this.host.offsetHeight > 0 ? rect.height / this.host.offsetHeight : 1,
    };
  }

  private findTarget(pointer: PointerPosition): ParagraphTarget | null {
    if (
      !this.view.editable || this.view.composing ||
      isInlineSourceComposing(this.view) || isActiveEditComposing(this.view)
    ) return null;
    const viewRect = this.view.dom.getBoundingClientRect();
    const paneRect = this.pane.getBoundingClientRect();
    const scale = this.getScale();
    const right = viewRect.left - GUTTER_GAP * scale.x;
    const left = right - GUTTER_WIDTH * scale.x;
    if (
      viewRect.width <= 0 || left < paneRect.left ||
      pointer.x < left || pointer.x > right ||
      pointer.y < paneRect.top || pointer.y >= paneRect.bottom
    ) return null;

    const doc = this.view.dom.ownerDocument;
    const surface = doc.elementFromPoint(pointer.x, pointer.y);
    // 只接管自身浮层和纸张留白，不穿透弹层、其它控件或正文内容。
    if (
      surface !== this.dom && surface !== this.host && surface !== this.pane &&
      surface !== this.host.parentElement
    ) return null;

    const element = doc.elementFromPoint(viewRect.left + Math.min(2 * scale.x, viewRect.width / 2), pointer.y)
      ?.closest('p, h1, h2, h3, h4, h5, h6');
    if (!(element instanceof HTMLElement) || element.parentElement !== this.view.dom) return null;
    const rect = element.getBoundingClientRect();
    // 段间 margin 不能被附近段落吸附；多行段落内的任意高度都指向同一内容范围。
    if (rect.height <= 0 || pointer.y < rect.top || pointer.y >= rect.bottom) return null;
    const from = this.view.posAtDOM(element, 0);
    const $from = this.view.state.doc.resolve(from);
    const node = $from.parent;
    if (
      $from.depth !== 1 || node.content.size === 0 ||
      (node.type.name !== 'paragraph' && node.type.name !== 'heading')
    ) return null;
    return {
      element,
      heading: node.type.name === 'heading',
      rect,
    };
  }
}
