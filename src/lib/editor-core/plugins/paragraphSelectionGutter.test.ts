import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { history, undo } from 'prosemirror-history';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseMarkdown } from '../markdown';
import { registerActiveEdit } from '../nodeViews/activeEditRegistry';
import { paragraphSelectionGutterPlugin } from './paragraphSelectionGutter';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let elementFromPointDescriptor: PropertyDescriptor | undefined;
const views: EditorView[] = [];

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
  if (elementFromPointDescriptor) {
    Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
  } else {
    Reflect.deleteProperty(document, 'elementFromPoint');
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function geometry(element: HTMLElement, x: number, y: number, width: number, height: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height));
}

function fixture(markdown: string, scale = 1) {
  const pane = document.createElement('div');
  pane.className = 'semantic-pane';
  const paper = document.createElement('div');
  const host = document.createElement('div');
  host.className = 'prosemirror-host';
  pane.appendChild(paper).appendChild(host);
  document.body.appendChild(pane);
  const dispatch = vi.fn();
  const view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown(markdown),
      plugins: [history(), paragraphSelectionGutterPlugin()],
    }),
    dispatchTransaction(transaction) {
      dispatch(transaction);
      view.updateState(view.state.apply(transaction));
    },
  });
  views.push(view);
  geometry(pane, 0, 0, 1000, 1000);
  geometry(host, 100, 40, 400 * scale, 400 * scale);
  geometry(view.dom, 100, 40, 400 * scale, 400 * scale);
  Object.defineProperties(host, {
    offsetWidth: { value: 400, configurable: true },
    offsetHeight: { value: 400, configurable: true },
  });
  const blocks = [...view.dom.children] as HTMLElement[];
  blocks.forEach((element, index) => geometry(element, 100, 80 + index * 120, 400 * scale, 80));
  const hit = vi.fn((x: number, y: number): Element => {
    if (x < 100) return paper;
    return blocks.find((block) => {
      const rect = block.getBoundingClientRect();
      return y >= rect.top && y < rect.bottom;
    }) ?? view.dom;
  });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  const button = host.querySelector<HTMLButtonElement>('.paragraph-selection-gutter')!;
  return { pane, paper, host, view, blocks, button, hit, dispatch };
}

function pointer(pane: HTMLElement, type: string, x: number, y: number, options: MouseEventInit = {}, pointerType = 'mouse') {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, ...options,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  pane.dispatchEvent(event);
  return event;
}

describe('paragraph selection gutter', () => {
  it('reveals one external handle without changing the document or existing selection on hover', () => {
    const { pane, view, button, dispatch } = fixture('第一段\n换行内容\n\n第二段');
    const state = view.state;
    expect(button.hidden).toBe(true);
    pointer(pane, 'pointermove', 86, 145);
    flushFrame();
    expect(button.hidden).toBe(false);
    expect(button.parentElement).toBe(view.dom.parentElement);
    expect(view.dom.contains(button)).toBe(false);
    expect(Number.parseFloat(button.style.left)).toBe(-24);
    expect(view.state).toBe(state);
    expect(dispatch).not.toHaveBeenCalled();
    pointer(pane, 'pointermove', 110, 110);
    flushFrame();
    expect(button.hidden).toBe(true);
    view.setProps({ editable: () => true });
    expect(frames.size).toBe(0);
    pointer(pane, 'pointermove', 86, 145);
    flushFrame();
    pane.dispatchEvent(new Event('pointerleave'));
    expect(button.hidden).toBe(true);
  });

  it('selects the entire multiline paragraph from any line without changing content or history', () => {
    const { pane, view } = fixture('第一行\n第二行\n第三行\n\n保留的下一段');
    const doc = view.state.doc;
    const event = pointer(pane, 'pointerdown', 86, 145);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.from).toBe(1);
    expect(view.state.selection.to).toBe(1 + doc.firstChild!.content.size);
    expect(doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('第一行第二行第三行');
    expect(view.state.doc).toBe(doc);
    expect(view.hasFocus()).toBe(true);
    expect(undo(view.state)).toBe(false);
  });

  it('selects a heading without its following paragraph and re-resolves positions after an edit', () => {
    const { pane, view } = fixture('# 标题\n\n正文');
    pointer(pane, 'pointermove', 86, 110);
    flushFrame();
    view.dispatch(view.state.tr.insertText('新增', 1));
    pointer(pane, 'pointerdown', 86, 110);
    const { doc, selection } = view.state;
    expect(doc.textBetween(selection.from, selection.to)).toBe('新增标题');
    expect(selection.to).toBe(doc.firstChild!.nodeSize - 1);
  });

  it('leaves body clicks, paragraph gaps, nested paragraphs, code blocks and obstructing controls alone', () => {
    const { pane, view, hit, dispatch } = fixture('普通段落\n\n> 引用段落\n\n```txt\n代码\n```');
    for (const [x, y] of [[110, 110], [86, 180], [86, 230], [86, 350]]) {
      expect(pointer(pane, 'pointerdown', x, y).defaultPrevented).toBe(false);
      pointer(pane, 'pointermove', x, y);
      flushFrame();
    }
    const originalHit = hit.getMockImplementation()!;
    const foreignButton = document.createElement('button');
    pane.appendChild(foreignButton);
    hit.mockImplementation((x, y) => x < 100 ? foreignButton : originalHit(x, y));
    expect(pointer(pane, 'pointerdown', 86, 110).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.selection.empty).toBe(true);
  });

  it('selects the intended block after a native editor commits earlier content and restores its own cursor', () => {
    const { pane, host, view } = fixture('前段\n\n# 目标标题');
    const input = document.createElement('input');
    host.appendChild(input);
    input.focus();
    const exit = vi.fn(() => {
      view.dispatch(view.state.tr.insertText('新增内容', 1));
    });
    registerActiveEdit(view, exit);
    input.addEventListener('blur', () => {
      view.dispatch(view.state.tr.setSelection(EditorState.create({ doc: view.state.doc }).selection));
    });
    pointer(pane, 'pointerdown', 86, 230);
    expect(exit).toHaveBeenCalledOnce();
    const { doc, selection } = view.state;
    expect(doc.firstChild!.textContent).toBe('新增内容前段');
    expect(doc.textBetween(selection.from, selection.to)).toBe('目标标题');
    expect(view.hasFocus()).toBe(true);
  });

  it('does not intercept modified clicks, right clicks, touch, dragging, composition or readonly views', () => {
    const { pane, view, button, dispatch } = fixture('普通段落');
    for (const options of [{ ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { button: 2 }]) {
      expect(pointer(pane, 'pointerdown', 86, 110, options).defaultPrevented).toBe(false);
    }
    expect(pointer(pane, 'pointerdown', 86, 110, {}, 'touch').defaultPrevented).toBe(false);
    pointer(pane, 'pointermove', 86, 110, { buttons: 1 });
    flushFrame();
    expect(button.hidden).toBe(true);
    const composing = vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
    expect(pointer(pane, 'pointerdown', 86, 110).defaultPrevented).toBe(false);
    composing.mockReturnValue(false);
    view.setProps({ editable: () => false });
    expect(pointer(pane, 'pointerdown', 86, 110).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('accounts for zoom and hides on scrolling, then releases its overlay and scheduled work on destroy', () => {
    const { pane, view, button } = fixture('缩放段落', 2);
    pointer(pane, 'pointermove', 60, 110);
    flushFrame();
    expect(button.hidden).toBe(false);
    expect(button.style.left).toBe('-24px');
    expect(pointer(pane, 'pointerdown', 60, 110).defaultPrevented).toBe(true);
    pane.dispatchEvent(new Event('scroll'));
    expect(button.hidden).toBe(true);
    pointer(pane, 'pointermove', 60, 110);
    expect(frames.size).toBe(1);
    view.destroy();
    views.splice(views.indexOf(view), 1);
    expect(button.isConnected).toBe(false);
    expect(frames.size).toBe(0);
    pointer(pane, 'pointermove', 60, 110);
    expect(frames.size).toBe(0);
  });
});
