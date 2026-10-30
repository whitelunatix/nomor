import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completionAcceptance,
  htmlCssCompletion,
  htmlCssCompletionField,
} from './htmlCssCompletionExtension';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function stateWith(source: string, readOnly = false) {
  const position = source.indexOf('|');
  return EditorState.create({
    doc: source.replace('|', ''),
    selection: { anchor: position },
    extensions: [htmlCssCompletionField, EditorState.readOnly.of(readOnly)],
  });
}

function mount(source: string) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const position = source.indexOf('|');
  const view = new EditorView({
    state: EditorState.create({
      doc: source.replace('|', ''),
      selection: { anchor: position },
      extensions: [htmlCssCompletion()],
    }),
    parent,
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 10, bottom: 20 });
  view.focus();
  return { view, parent };
}

function press(view: EditorView, key: string) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

describe('htmlCssCompletionField', () => {
  it('在光标位置形成可直接应用的替换', () => {
    expect(completionAcceptance(stateWith('<di|'))).toEqual({
      from: 1,
      to: 3,
      insert: 'dialog',
    });
    expect(completionAcceptance(stateWith('<div style="col|'))).toEqual({
      from: '<div style="'.length,
      to: '<div style="col'.length,
      insert: 'color: ',
    });
    expect(completionAcceptance(stateWith('<div style="color: re|'))?.insert).toBe('red');
    expect(completionAcceptance(stateWith('普通正文|'))).toBeNull();
    expect(completionAcceptance(stateWith('<di|', true))).toBeNull();
  });

  it('随文档输入更新，离开上下文后清空', () => {
    let state = stateWith('<d|');
    expect(state.field(htmlCssCompletionField)?.request.prefix).toBe('d');

    state = state.update({
      changes: { from: 2, insert: 'i' },
      selection: { anchor: 3 },
    }).state;
    expect(state.field(htmlCssCompletionField)?.request.prefix).toBe('di');

    state = state.update({
      changes: { from: 3, insert: '>' },
      selection: { anchor: 4 },
    }).state;
    expect(state.field(htmlCssCompletionField)).toBeNull();
  });

  it('上下键切换候选', () => {
    const { view } = mount('<di|');
    press(view, 'ArrowDown');
    expect(document.querySelector('.html-css-completion-item.is-active')?.textContent).toContain(
      'div',
    );
    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('<div');
    view.destroy();
  });

  it('Enter 接受当前候选，Esc 关闭弹层', () => {
    const { view } = mount('<di|');
    expect(document.querySelectorAll('.html-css-completion-item')).toHaveLength(2);

    press(view, 'Enter');
    expect(view.state.doc.toString()).toBe('<dialog');
    expect(view.state.selection.main.head).toBe('<dialog'.length);

    view.dispatch({ changes: { from: 7, insert: ' ' }, selection: { anchor: 8 } });
    expect(view.state.field(htmlCssCompletionField)?.request.kind).toBe('attribute');
    expect(view.hasFocus).toBe(true);
    expect(document.querySelectorAll('.html-css-completion-item').length).toBeGreaterThan(0);

    press(view, 'Escape');
    expect(document.querySelectorAll('.html-css-completion-item')).toHaveLength(0);

    view.destroy();
  });
});
