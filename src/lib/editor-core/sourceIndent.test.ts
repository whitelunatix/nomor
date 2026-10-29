import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  indentSourceLines,
  outdentSourceLines,
  outdentWidth,
  selectedLineNumbers,
  sourceIndentKeymap,
} from './sourceIndent';

function createView(doc: string, selection?: { anchor: number; head?: number }, readonly = false) {
  const host = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        sourceIndentKeymap(),
        EditorState.readOnly.of(readonly),
      ],
    }),
    parent: host,
  });
  return { host, view };
}

function cleanup(host: HTMLElement, view: EditorView) {
  view.destroy();
  host.remove();
}

describe('selectedLineNumbers', () => {
  it('includes every line the selection touches', () => {
    const state = EditorState.create({ doc: '一\n二\n三', selection: { anchor: 1, head: 4 } });
    expect(selectedLineNumbers(state)).toEqual([1, 2]);
  });

  it('drops the next line when the selection stops at its start', () => {
    const state = EditorState.create({ doc: 'ab\ncd', selection: { anchor: 1, head: 3 } });
    expect(selectedLineNumbers(state)).toEqual([1]);
  });

  it('deduplicates lines shared by multiple cursors', () => {
    const state = EditorState.create({
      doc: 'abc',
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(2),
      ]),
    });
    expect(selectedLineNumbers(state)).toEqual([1]);
  });
});

describe('outdentWidth', () => {
  it('removes at most one indent unit', () => {
    expect(outdentWidth('    text')).toBe(2);
    expect(outdentWidth('  text')).toBe(2);
    expect(outdentWidth(' text')).toBe(1);
    expect(outdentWidth('\ttext')).toBe(1);
    expect(outdentWidth('text')).toBe(0);
  });
});

describe('source indentation commands', () => {
  it('inserts one indent unit at an empty cursor', () => {
    const { host, view } = createView('abc', { anchor: 1 });

    expect(indentSourceLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('a  bc');
    expect(view.state.selection.main.head).toBe(3);

    cleanup(host, view);
  });

  it('indents every line covered by a selection', () => {
    const { host, view } = createView('a\nb', { anchor: 0, head: 3 });

    expect(indentSourceLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('  a\n  b');
    // 两个行首都插入了缩进，选区终点随之后移，仍覆盖整段内容。
    expect(view.state.selection.main.from).toBe(2);
    expect(view.state.selection.main.to).toBe(7);

    cleanup(host, view);
  });

  it('outdents lines by one level', () => {
    const { host, view } = createView('    a\n  b', { anchor: 2, head: 9 });

    expect(outdentSourceLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('  a\nb');

    cleanup(host, view);
  });

  it('clears partial indentation instead of leaving a stray space', () => {
    const { host, view } = createView(' a', { anchor: 2 });

    expect(outdentSourceLines(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('a');
    expect(view.state.selection.main.head).toBe(1);

    cleanup(host, view);
  });

  it('does nothing when there is no indentation to remove', () => {
    const { host, view } = createView('text', { anchor: 1 });

    expect(outdentSourceLines(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('text');

    cleanup(host, view);
  });

  it('leaves read-only documents untouched', () => {
    const { host, view } = createView('text', { anchor: 1 }, true);

    expect(indentSourceLines(view)).toBe(false);
    expect(outdentSourceLines(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('text');

    cleanup(host, view);
  });
});
