import { afterEach, describe, expect, it } from 'vitest';
import { history, undo, redo, undoDepth } from 'prosemirror-history';
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PmNode } from 'prosemirror-model';
import { schema } from '../schema';
import { parseMarkdown, serializeMarkdown } from '../markdown';
import { executeEditorCommand, insertQuickInsertContent } from '../editorCommands';
import { awaitActiveEditCompositionEnd, commitActiveEdit } from '../nodeViews/activeEditRegistry';
import {
  canInsertMathInline,
  mathInlineDraftKey,
  mathInlineDraftPlugin,
  startMathInlineDraft,
} from './mathInlineDraft';
import { createEditorCore } from '../createEditorCore';
import type { EditorCore } from '../types';

const views: EditorView[] = [];
const cores: EditorCore[] = [];
function core() {
  const target = document.createElement('div');
  document.body.append(target);
  const editor = createEditorCore({ markdown: 'before text after', target });
  cores.push(editor);
  const view = (editor as unknown as { view: EditorView }).view;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 12)));
  return { editor, view, target };
}
function create(doc: PmNode = parseMarkdown('before text after'), from = 8, to = 12) {
  const host = document.createElement('div');
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
      plugins: [history(), mathInlineDraftPlugin()],
    }),
  });
  views.push(view);
  return view;
}
function input(view: EditorView): HTMLInputElement {
  return view.dom.querySelector('.math-inline-draft input')!;
}
function press(view: EditorView, key: string) {
  input(view).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
function begin(view: EditorView) {
  expect(executeEditorCommand({ type: 'insertMathInline' }, view, '', () => undefined)).toBe(true);
  expect(input(view)).not.toBeNull();
}

afterEach(() => {
  for (const editor of cores.splice(0)) editor.destroy();
  for (const view of views.splice(0)) {
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
  expect(document.querySelector('.math-inline-preview')).toBeNull();
});

describe('inline formula insertion draft', () => {
  it('keeps an empty draft out of the document and undo history, including immediate save', () => {
    const view = create(undefined, 8, 8);
    const original = view.state.doc;
    begin(view);
    expect(input(view).value).toBe('');
    expect(view.state.doc.eq(original)).toBe(true);
    commitActiveEdit(view);
    expect(view.state.doc.eq(original)).toBe(true);
    expect(mathInlineDraftKey.getState(view.state)).toBeNull();
    expect(undoDepth(view.state)).toBe(0);
    expect(serializeMarkdown(view.state.doc)).not.toContain('$$');
  });

  it.each(['Escape', 'Enter', 'blur'])(
    'restores formatted reverse selection on %s without a history entry',
    (exit) => {
      const doc = schema.nodes.doc.create(
        null,
        schema.nodes.paragraph.create(null, [
          schema.text('before '),
          schema.text('text', [schema.marks.strong.create()]),
          schema.text(' after'),
        ]),
      );
      const view = create(doc, 12, 8);
      for (let n = 0; n < 3; n++) {
        begin(view);
        expect(input(view).value).toBe('text');
        input(view).value = exit === 'Escape' ? 'changed' : '   ';
        if (exit === 'blur') input(view).dispatchEvent(new FocusEvent('blur'));
        else press(view, exit);
        expect(view.state.doc.eq(doc)).toBe(true);
        expect(view.state.selection.anchor).toBe(12);
        expect(view.state.selection.head).toBe(8);
        expect(undoDepth(view.state)).toBe(0);
      }
    },
  );

  it.each(['Enter', 'blur', 'save'])(
    'commits once on %s, undo restores original selection and redo restores final formula',
    (exit) => {
      const view = create(undefined, 12, 8);
      const original = view.state.doc;
      begin(view);
      input(view).value = 'x^2';
      if (exit === 'save') commitActiveEdit(view, true);
      else if (exit === 'blur') input(view).dispatchEvent(new FocusEvent('blur'));
      else press(view, exit);
      expect(serializeMarkdown(view.state.doc).trim()).toBe('before $x^2$ after');
      expect(view.state.selection.from).toBe(9);
      expect(undoDepth(view.state)).toBe(1);
      const committed = view.state.doc;
      expect(undo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(original)).toBe(true);
      expect(view.state.selection.anchor).toBe(12);
      expect(view.state.selection.head).toBe(8);
      expect(redo(view.state, view.dispatch)).toBe(true);
      expect(view.state.doc.eq(committed)).toBe(true);
      expect(parseMarkdown(serializeMarkdown(committed)).eq(committed)).toBe(true);
    },
  );

  it('inserts at an empty caret without changing surrounding text', () => {
    const view = create(undefined, 8, 8);
    begin(view);
    input(view).value = 'a+b';
    press(view, 'Enter');
    expect(serializeMarkdown(view.state.doc).trim()).toBe('before $a+b$text after');
  });

  it('keeps the quick-insert trigger until confirmation and restores it on cancellation', () => {
    const view = create(parseMarkdown('before / after'), 9, 9);
    const original = view.state.doc;
    expect(insertQuickInsertContent(view, 8, 9, { type: 'insertMathInline' })).toBe(true);
    expect(input(view).value).toBe('');
    press(view, 'Escape');
    expect(view.state.doc.eq(original)).toBe(true);
    expect(view.state.selection.anchor).toBe(9);
    expect(view.state.selection.head).toBe(9);
    expect(insertQuickInsertContent(view, 8, 9, { type: 'insertMathInline' })).toBe(true);
    input(view).value = 'x';
    press(view, 'Enter');
    expect(serializeMarkdown(view.state.doc).trim()).toBe('before $x$ after');
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(original)).toBe(true);
  });

  it('maps the target around unrelated changes but cancels on replacement or formatting changes', () => {
    const view = create();
    begin(view);
    input(view).value = 'x';
    view.dispatch(view.state.tr.insertText('prefix ', 1));
    press(view, 'Enter');
    expect(serializeMarkdown(view.state.doc).trim()).toBe('prefix before $x$ after');

    const other = create();
    begin(other);
    other.dispatch(other.state.tr.insertText('new', 8, 12));
    expect(mathInlineDraftKey.getState(other.state)).toBeNull();
    expect(input(other)).toBeNull();
    expect(serializeMarkdown(other.state.doc).trim()).toBe('before new after');

    const formatted = create();
    begin(formatted);
    formatted.dispatch(formatted.state.tr.addMark(8, 12, schema.marks.strong.create()));
    expect(mathInlineDraftKey.getState(formatted.state)).toBeNull();
  });

  it('waits for the final composition input before committing and ignores Enter during IME', async () => {
    const view = create();
    const original = view.state.doc;
    begin(view);
    const field = input(view);
    field.dispatchEvent(new CompositionEvent('compositionstart'));
    field.value = '中';
    press(view, 'Enter');
    commitActiveEdit(view);
    expect(view.state.doc.eq(original)).toBe(true);
    const waiting = awaitActiveEditCompositionEnd(view);
    field.dispatchEvent(new CompositionEvent('compositionend'));
    field.value = '中文';
    field.dispatchEvent(new Event('input'));
    await waiting;
    commitActiveEdit(view);
    expect(serializeMarkdown(view.state.doc).trim()).toBe('before $中文$ after');
  });

  it('does not share buffers between documents and releases composition waiters on destruction', async () => {
    const first = create();
    const second = create();
    begin(first);
    begin(second);
    input(first).value = 'one';
    input(second).value = 'two';
    commitActiveEdit(first);
    expect(serializeMarkdown(first.state.doc).trim()).toBe('before $one$ after');
    expect(input(second).value).toBe('two');
    input(second).dispatchEvent(new CompositionEvent('compositionstart'));
    const waiting = awaitActiveEditCompositionEnd(second);
    second.destroy();
    await waiting;
    expect(second.state.doc.textContent).toBe('before text after');
  });

  it('rejects cross-block, code, object, and node selections', () => {
    const doc = parseMarkdown('first\n\nsecond');
    const cross = create(doc, 2, 10);
    expect(startMathInlineDraft(cross)).toBe(false);
    const code = create(parseMarkdown('```\ncode\n```'), 1, 3);
    expect(startMathInlineDraft(code)).toBe(false);
    const image = create(parseMarkdown('![x](a.png)'), 1, 2);
    expect(startMathInlineDraft(image)).toBe(false);
    image.dispatch(image.state.tr.setSelection(NodeSelection.create(image.state.doc, 1)));
    expect(canInsertMathInline(image.state)).toBe(false);
  });

  it.each(['- text', '> text', '# text', '| A |\n| --- |\n| text |'])(
    'supports nested text containers: %s',
    (markdown) => {
      const doc = parseMarkdown(markdown);
      let from = 0;
      doc.descendants((node, pos) => {
        if (node.isText && node.text === 'text') from = pos;
      });
      const view = create(doc, from, from + 4);
      begin(view);
      input(view).value = 'x';
      press(view, 'Enter');
      expect(serializeMarkdown(view.state.doc)).toContain('$x$');
    },
  );

  it('never commits after becoming readonly', () => {
    const view = create();
    const original = view.state.doc;
    begin(view);
    input(view).value = 'new';
    view.setProps({ editable: () => false });
    commitActiveEdit(view);
    expect(view.state.doc.eq(original)).toBe(true);
    expect(startMathInlineDraft(view)).toBe(false);
  });

  it('separates a formula commit from earlier typing and a cancellation leaves earlier undo intact', () => {
    const view = create();
    view.dispatch(view.state.tr.insertText('!', 1));
    const beforeDraft = view.state.doc;
    begin(view);
    press(view, 'Escape');
    expect(undoDepth(view.state)).toBe(1);
    begin(view);
    input(view).value = 'x';
    press(view, 'Enter');
    expect(undoDepth(view.state)).toBe(2);
    undo(view.state, view.dispatch);
    expect(view.state.doc.eq(beforeDraft)).toBe(true);
    undo(view.state, view.dispatch);
    expect(serializeMarkdown(view.state.doc).trim()).toBe('before text after');
  });

  it('integrates with core save/snapshot, source-mode gating, mode change and readonly cancellation', () => {
    const { editor, view } = core();
    expect(editor.canExecute({ type: 'insertMathInline' })).toBe(true);
    expect(editor.execute({ type: 'insertMathInline' })).toBe(true);
    input(view).value = 'x^2';
    editor.commitPendingEdits();
    expect(editor.getMarkdown().trim()).toBe('before $x^2$ after');
    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(editor.getMarkdown().trim()).toBe('before text after');
    expect(editor.execute({ type: 'insertMathInline' })).toBe(true);
    input(view).value = 'y';
    editor.updateOptions({ mode: 'source' });
    expect(editor.getMarkdown().trim()).toBe('before $y$ after');
    expect(editor.canExecute({ type: 'insertMathInline' })).toBe(false);
    expect(editor.execute({ type: 'insertMathInline' })).toBe(false);
    editor.updateOptions({ mode: 'semantic' });
    expect(editor.execute({ type: 'undo' })).toBe(true);
    const beforeReadonly = editor.getMarkdown();
    expect(editor.execute({ type: 'insertMathInline' })).toBe(true);
    input(view).value = 'discard';
    editor.updateOptions({ readonly: true });
    expect(editor.getMarkdown()).toBe(beforeReadonly);
    expect(mathInlineDraftKey.getState(view.state)).toBeNull();
  });

  it('does not resurrect an unfinished draft after unmount/remount', async () => {
    const { editor, view, target } = core();
    expect(editor.execute({ type: 'insertMathInline' })).toBe(true);
    input(view).value = 'discard';
    input(view).dispatchEvent(new CompositionEvent('compositionstart'));
    const waiting = editor.awaitCompositionEnd!();
    editor.unmount();
    await waiting;
    editor.mount(target);
    expect(editor.getMarkdown().trim()).toBe('before text after');
    expect(target.querySelector('.math-inline-draft')).toBeNull();
  });

  it('discards a composing draft if a forced mode change hides the editor', async () => {
    const { editor, view, target } = core();
    expect(editor.execute({ type: 'insertMathInline' })).toBe(true);
    input(view).dispatchEvent(new CompositionEvent('compositionstart'));
    input(view).value = 'unfinished';
    const waiting = editor.awaitCompositionEnd!();
    editor.updateOptions({ mode: 'source' });
    await waiting;
    editor.updateOptions({ mode: 'semantic' });
    expect(target.querySelector('.math-inline-draft')).toBeNull();
    expect(editor.getMarkdown().trim()).toBe('before text after');
  });
});
