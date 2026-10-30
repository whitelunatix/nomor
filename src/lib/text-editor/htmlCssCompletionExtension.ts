/**
 * 为 Markdown 源码编辑器提供 HTML5 / CSS3 补全弹层。
 *
 * 项目只直接依赖 CodeMirror 的 commands / state / view，没有安装
 * `@codemirror/autocomplete`，这里用 StateField + ViewPlugin 实现同等的最小交互：
 * ↑/↓ 选择、Enter/Tab 接受、Esc 关闭，鼠标点击也能接受。
 */

import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import {
  COMPLETION_SCAN_WINDOW,
  detectHtmlCssCompletion,
  type CompletionRequest,
} from './htmlCssCompletion';

export interface HtmlCssCompletionState {
  request: CompletionRequest;
  active: number;
}

const dismissCompletion = StateEffect.define<null>();
const setActiveCompletion = StateEffect.define<number>();
const MAX_VISIBLE_ITEMS = 8;

export const htmlCssCompletionField = StateField.define<HtmlCssCompletionState | null>({
  create: (state) => findCompletion(state),
  update(value, transaction) {
    if (transaction.effects.some((effect) => effect.is(dismissCompletion))) return null;
    const nextActive = transaction.effects.find((effect) => effect.is(setActiveCompletion));
    if (nextActive) {
      if (!value) return null;
      const index = Math.max(0, Math.min(nextActive.value, value.request.items.length - 1));
      return { request: value.request, active: index };
    }
    if (transaction.docChanged || transaction.selection !== undefined) {
      return findCompletion(transaction.state);
    }
    return value;
  },
});

function findCompletion(state: EditorState): HtmlCssCompletionState | null {
  if (state.readOnly) return null;
  const head = state.selection.main.head;
  if (!state.selection.main.empty) return null;
  const start = Math.max(0, head - COMPLETION_SCAN_WINDOW);
  const text = state.doc.sliceString(start, head);
  const request = detectHtmlCssCompletion(text, text.length);
  if (!request) return null;
  return {
    request: { ...request, from: request.from + start, to: request.to + start },
    active: 0,
  };
}

export interface CompletionAcceptance {
  from: number;
  to: number;
  insert: string;
}

/** 当前候选对应的替换内容；供接受命令与测试共用。 */
export function completionAcceptance(state: EditorState): CompletionAcceptance | null {
  const completion = state.field(htmlCssCompletionField, false);
  if (!completion) return null;
  const item = completion.request.items[completion.active];
  if (!item) return null;
  return {
    from: completion.request.from,
    to: completion.request.to,
    insert: completion.request.kind === 'css-property' ? `${item.label}: ` : item.label,
  };
}

function acceptCompletion(view: EditorView): boolean {
  const acceptance = completionAcceptance(view.state);
  if (!acceptance) return false;
  const transaction = view.state.update({
    changes: acceptance,
    selection: { anchor: acceptance.from + acceptance.insert.length },
    userEvent: 'input.complete',
    scrollIntoView: true,
  });
  view.dispatch(transaction);
  return true;
}

function moveCompletion(view: EditorView, delta: number): boolean {
  const state = view.state.field(htmlCssCompletionField, false);
  if (!state) return false;
  const count = state.request.items.length;
  const active = (state.active + delta + count) % count;
  view.dispatch({ effects: setActiveCompletion.of(active) });
  return true;
}

function dismissActiveCompletion(view: EditorView): boolean {
  if (!view.state.field(htmlCssCompletionField, false)) return false;
  view.dispatch({ effects: dismissCompletion.of(null) });
  return true;
}

const completionKeymap = Prec.highest(
  keymap.of([
    { key: 'ArrowDown', run: (view) => moveCompletion(view, 1) },
    { key: 'ArrowUp', run: (view) => moveCompletion(view, -1) },
    { key: 'Enter', run: acceptCompletion },
    { key: 'Tab', run: acceptCompletion },
    { key: 'Escape', run: dismissActiveCompletion },
  ]),
);

class CompletionPopup {
  readonly dom = document.createElement('div');
  private readonly handleFocus = () => this.render();
  private readonly handleBlur = () => this.hide();
  private readonly handleScroll = () => {
    if (this.view.state.field(htmlCssCompletionField, false)) this.render();
  };

  constructor(private readonly view: EditorView) {
    this.dom.className = 'html-css-completion';
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', 'HTML/CSS 补全');
    document.body.appendChild(this.dom);
    // 焦点切换不一定产生 ViewUpdate，单独监听，避免挂载后重新聚焦时弹层不出现。
    view.contentDOM.addEventListener('focus', this.handleFocus);
    view.contentDOM.addEventListener('blur', this.handleBlur);
    view.scrollDOM.addEventListener('scroll', this.handleScroll, { passive: true });
    this.render();
  }

  update(update: ViewUpdate) {
    // 关闭和上下选择只带 StateEffect，没有文档/选区变化，也必须重绘。
    if (
      update.docChanged ||
      update.selectionSet ||
      update.focusChanged ||
      update.viewportChanged ||
      update.transactions.length > 0
    ) {
      this.render();
    }
  }

  private render() {
    const state = this.view.state.field(htmlCssCompletionField, false);
    if (!state || !this.view.hasFocus) {
      this.hide();
      return;
    }
    const visible = state.request.items.slice(0, MAX_VISIBLE_ITEMS);
    this.dom.replaceChildren();
    visible.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `html-css-completion-item${index === state.active ? ' is-active' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === state.active));
      const label = document.createElement('span');
      label.className = 'html-css-completion-label';
      label.textContent = item.label;
      const detail = document.createElement('span');
      detail.className = 'html-css-completion-detail';
      detail.textContent = item.detail;
      button.append(label, detail);
      // 保住编辑器焦点，点击才不会先失焦再触发 blur 隐藏。
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        this.view.dispatch({ effects: setActiveCompletion.of(index) });
        acceptCompletion(this.view);
        this.view.focus();
      });
      this.dom.appendChild(button);
    });
    if (visible.length === 0) {
      this.hide();
      return;
    }
    this.dom.style.display = 'block';
    this.position(state.request.to, state.active);
  }

  private position(position: number, active: number) {
    const coords = this.view.coordsAtPos(position);
    if (!coords) {
      this.hide();
      return;
    }
    const margin = 8;
    const width = this.dom.offsetWidth;
    const height = this.dom.offsetHeight;
    const left = Math.min(
      Math.max(margin, coords.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    let top = coords.bottom + 4;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, coords.top - height - 4);
    }
    this.dom.style.left = `${left}px`;
    this.dom.style.top = `${top}px`;
    const activeItem = this.dom.children[active] as HTMLElement | undefined;
    // jsdom 等测试环境没有实现 scrollIntoView，真实浏览器才有。
    if (typeof activeItem?.scrollIntoView === 'function') {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }

  private hide() {
    this.dom.style.display = 'none';
    this.dom.replaceChildren();
  }

  destroy() {
    this.view.contentDOM.removeEventListener('focus', this.handleFocus);
    this.view.contentDOM.removeEventListener('blur', this.handleBlur);
    this.view.scrollDOM.removeEventListener('scroll', this.handleScroll);
    this.dom.remove();
  }
}

/** 挂到 Markdown 源码编辑器的扩展。 */
export function htmlCssCompletion(): Extension {
  return [
    htmlCssCompletionField,
    completionKeymap,
    ViewPlugin.fromClass(CompletionPopup),
  ];
}
