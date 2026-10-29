import { afterEach, describe, expect, it, vi } from 'vitest';
import { undo, undoDepth } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { registerActiveEdit } from './nodeViews/activeEditRegistry';

const editors: EditorCore[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function fixture(readonly = false) {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const onSelectionSnapshotChange = vi.fn();
  const editor = createEditorCore({ target: host, markdown: '第一段 hello\n\n第二段 world', readonly, onSelectionSnapshotChange });
  editors.push(editor);
  const view = (editor as unknown as { view: EditorView }).view;
  await new Promise(requestAnimationFrame);
  vi.spyOn(view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 400, 160));
  [...view.dom.children].forEach((block, index) => {
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50 + index * 80, 400, 30));
  });
  const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 4, inside: 0 });
  return { editor, view, hit, onSelectionSnapshotChange };
}

describe('paper caret placement', () => {
  it.each([false, true])('collapses a %s reverse selection in both model and DOM without editing or adding history', async (reverse) => {
    const { editor, view, hit, onSelectionSnapshotChange } = await fixture();
    const doc = view.state.doc;
    const end = doc.content.size - 1;
    editor.restoreSelectionSnapshot({ anchor: reverse ? end : 1, head: reverse ? 1 : end });
    editor.focus();
    expect(document.getSelection()?.isCollapsed).toBe(false);
    expect(editor.placeCaretAtCoordinates({ left: 650, top: 90 })).toBe(true);
    expect(hit).toHaveBeenCalledWith({ left: 499, top: 90 });
    expect(view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 4, head: 4 });
    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(view.dom.contains(document.getSelection()!.anchorNode)).toBe(true);
    expect(view.dom.querySelector('.pm-inline-selection-bridge')).toBeNull();
    expect(view.dom.hasAttribute('data-nomo-selection-active')).toBe(false);
    expect(view.state.doc).toBe(doc);
    expect(undoDepth(view.state)).toBe(0);
    expect(onSelectionSnapshotChange).toHaveBeenLastCalledWith({ selection: null, contentRevision: 0 });
    view.dispatch(view.state.tr.insertText('输入'));
    expect(view.state.doc.textContent).toContain('第一段输入 hello');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.eq(doc)).toBe(true);
  });

  it('clamps left, top and bottom whitespace to valid text positions', async () => {
    const { editor, view, hit } = await fixture();
    hit.mockReturnValue({ pos: 1, inside: 0 });
    editor.placeCaretAtCoordinates({ left: 30, top: 70 });
    expect(hit).toHaveBeenLastCalledWith({ left: 101, top: 70 });
    editor.placeCaretAtCoordinates({ left: 300, top: 10 });
    expect(view.state.selection.head).toBe(1);
    // 最后一段结束于 160，编辑面 min-height 延伸到 210。
    editor.placeCaretAtCoordinates({ left: 300, top: 180 });
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);
    expect(view.state.selection.empty).toBe(true);
  });

  it('uses the adjacent block when native coordinate mapping cannot find a position', async () => {
    const { editor, view, hit } = await fixture();
    hit.mockReturnValue(null);
    const [first, second] = [...view.dom.children];
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 400, 40));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 150, 400, 40));
    editor.placeCaretAtCoordinates({ left: 30, top: 130 });
    expect(view.state.selection.head).toBe(view.state.doc.firstChild!.nodeSize + 1);
    editor.placeCaretAtCoordinates({ left: 650, top: 180 });
    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);
  });

  it('commits node inputs and their blur handlers before resolving the latest document', async () => {
    const { editor, view, hit } = await fixture();
    const input = document.createElement('textarea');
    view.dom.parentElement!.append(input);
    input.focus();
    const commit = vi.fn(() => view.dispatch(view.state.tr.insertText('提交内容', 1)));
    registerActiveEdit(view, commit);
    input.addEventListener('blur', () => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1))));
    hit.mockImplementation(() => {
      expect(document.activeElement).toBe(view.dom);
      expect(view.state.doc.textContent.startsWith('提交内容')).toBe(true);
      return { pos: view.state.doc.firstChild!.nodeSize + 1, inside: 0 };
    });
    editor.placeCaretAtCoordinates({ left: 30, top: 145 });
    expect(commit).toHaveBeenCalledOnce();
    expect(view.state.selection.head).toBe(view.state.doc.firstChild!.nodeSize + 1);
    expect(undoDepth(view.state)).toBe(1);
  });

  it('does not move focus or commit during document or node composition', async () => {
    const { editor, view, hit } = await fixture();
    const composing = vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
    expect(editor.placeCaretAtCoordinates({ left: 30, top: 90 })).toBe(false);
    composing.mockRestore();
    const commit = vi.fn();
    registerActiveEdit(view, commit, undefined, { isComposing: () => true });
    expect(editor.placeCaretAtCoordinates({ left: 30, top: 90 })).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(hit).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(view.dom);
  });

  it('rejects readonly, detached and unmounted views without creating another view', async () => {
    const { editor, view, hit } = await fixture(true);
    expect(editor.placeCaretAtCoordinates({ left: 30, top: 90 })).toBe(false);
    expect(view.dom.getAttribute('contenteditable')).toBe('false');
    editor.updateOptions({ readonly: false });
    view.dom.parentElement!.remove();
    expect(editor.placeCaretAtCoordinates({ left: 30, top: 90 })).toBe(false);
    editor.unmount();
    expect(editor.placeCaretAtCoordinates({ left: 30, top: 90 })).toBe(false);
    expect(hit).not.toHaveBeenCalled();
  });
});
