import { describe, expect, it, vi } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { schema } from './schema';
import { handleTripleClickByDetail, tripleClickSelectionAt } from './tripleClickSelection';

const doc = schema.node('doc', null, [
  schema.node('paragraph', null, [schema.text('第一段')]),
  schema.node('bullet_list', null, [
    schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('列表项正文')])]),
  ]),
  schema.node('horizontal_rule'),
]);

function viewAt(inside: number) {
  const state = EditorState.create({ doc });
  const view = {
    state,
    posAtCoords: () => ({ pos: inside, inside }),
    hasFocus: () => true,
    focus: vi.fn(),
    dispatch: vi.fn((tr) => {
      view.state = view.state.apply(tr);
    }),
  };
  return view;
}

function mouse(detail: number, init: MouseEventInit = {}) {
  return new MouseEvent('mousedown', { button: 0, detail, cancelable: true, ...init });
}

describe('tripleClickSelectionAt', () => {
  it('列表项内三击选中所在段落的全部文字，不跨到相邻块', () => {
    const inside = 3 + 1 + 1 + 1 + 2; // 列表段落内部
    const selection = tripleClickSelectionAt(doc, inside);
    expect(selection).toBeInstanceOf(TextSelection);
    expect(doc.textBetween(selection!.from, selection!.to)).toBe('列表项正文');
  });

  it('可选中的非文本块返回节点选区，点在块之间返回 null', () => {
    const hrPos = doc.content.size - 1;
    expect(tripleClickSelectionAt(doc, hrPos)).toBeInstanceOf(NodeSelection);
    expect(tripleClickSelectionAt(doc, -1)).toBeNull();
  });
});

describe('handleTripleClickByDetail', () => {
  it('按 event.detail 识别三击并阻止原生段落选择', () => {
    const view = viewAt(2);
    const event = mouse(3);
    expect(handleTripleClickByDetail(view as unknown as EditorView, event)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('第一段');
  });

  it('单击、双击和带修饰键的三击交还给默认处理', () => {
    for (const event of [mouse(1), mouse(2), mouse(3, { shiftKey: true })]) {
      const view = viewAt(2);
      expect(handleTripleClickByDetail(view as unknown as EditorView, event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(view.dispatch).not.toHaveBeenCalled();
    }
  });
});
