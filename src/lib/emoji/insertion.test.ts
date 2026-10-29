import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/svelte/pure';
import { EditorView as SourceView } from '@codemirror/view';
import { EditorState as SemanticState, TextSelection } from 'prosemirror-state';
import { EditorView as SemanticView } from 'prosemirror-view';
import { history, undo, redo } from 'prosemirror-history';
import { loadEmojiCatalog } from '../../app/services/emojiCatalog';
import { buildEmojiCatalog } from './catalog';
import { emojiSuggestionsPlugin } from '../editor-core/plugins/emojiSuggestions';
import { parseMarkdown } from '../editor-core/markdown';
import { createEditorCore } from '../editor-core/createEditorCore';
import { setTypographyOptions } from '../typography/options';
import { DEFAULT_TYPOGRAPHY } from '../typography/types';
import MarkdownSourceEditor from '../../app/components/MarkdownSourceEditor.svelte';
import EmojiPicker from '../../app/components/EmojiPicker.svelte';
import type { MarkdownSourceEditorHandle } from '../../app/components/markdownSourceEditor';
import { fixture } from './catalog.fixture';

vi.mock('../../app/services/emojiCatalog', () => ({ loadEmojiCatalog: vi.fn() }));
const catalog = buildEmojiCatalog(fixture);
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  vi.mocked(loadEmojiCatalog).mockReset().mockResolvedValue(catalog);
  setTypographyOptions({ ...DEFAULT_TYPOGRAPHY, enabled: false });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  cleanup();
  vi.restoreAllMocks();
  setTypographyOptions(DEFAULT_TYPOGRAPHY);
});

function semantic(markdown = '') {
  const host = document.createElement('div');
  document.body.append(host);
  const view = new SemanticView(host, {
    state: SemanticState.create({
      doc: parseMarkdown(markdown),
      plugins: [emojiSuggestionsPlugin(() => true), history()],
    }),
  });
  disposers.push(() => {
    view.destroy();
    host.remove();
  });
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 10, bottom: 30 });
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, Math.max(1, view.state.doc.content.size - 1)),
    ),
  );
  view.focus();
  return view;
}
function type(view: SemanticView, text: string) {
  const { from, to } = view.state.selection;
  view.someProp('handleTextInput', (handler) =>
    handler(view, from, to, text, () => view.state.tr.insertText(text)),
  );
  view.dispatch(view.state.tr.insertText(text));
}
function press(view: SemanticView, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, ...options });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

describe('emoji insertion', () => {
  it('does not revive a completion session when a cached semantic state is remounted', async () => {
    const previous = semantic(':smi');
    previous.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    previous.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    const state = previous.state;
    previous.destroy();
    const host = document.createElement('div');
    document.body.append(host);
    const next = new SemanticView(host, { state });
    disposers.push(() => {
      next.destroy();
      host.remove();
    });
    next.focus();
    next.dispatch(next.state.tr.setMeta('remount-check', true));
    await Promise.resolve();
    expect(loadEmojiCatalog).not.toHaveBeenCalled();
    expect(document.querySelector('.emoji-suggestions')).toBeNull();
  });
  it('waits for Chinese composition to finish before showing suggestions', async () => {
    const view = semantic(':开');
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    type(view, '心');
    expect(loadEmojiCatalog).not.toHaveBeenCalled();
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await waitFor(() => expect(document.querySelector('.emoji-suggestion')).not.toBeNull());
    expect(view.state.doc.textContent).toBe(':开心');
  });
  it('confirms a semantic shortcode with Tab and isolates undo/redo and following text', async () => {
    const view = semantic('hello :sm');
    type(view, 'i');
    await waitFor(() => expect(document.querySelectorAll('.emoji-suggestion')).toHaveLength(1));
    expect(view.dom.getAttribute('aria-activedescendant')).toContain('emoji-suggestions');
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.textContent).toBe('hello 😄');
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.textContent).toBe('hello :smi');
    expect(redo(view.state, view.dispatch)).toBe(true);
    type(view, 'x');
    undo(view.state, view.dispatch);
    expect(view.state.doc.textContent).toBe('hello 😄');
  });
  it('keeps a closing colon literal until confirmation and ignores composition keys', async () => {
    const view = semantic(':smile');
    type(view, ':');
    await waitFor(() => expect(document.querySelector('.emoji-suggestion')).not.toBeNull());
    expect(view.state.doc.textContent).toBe(':smile:');
    expect(press(view, 'Enter', { isComposing: true })).toBe(false);
    expect(press(view, 'Enter', { shiftKey: true })).toBe(false);
    expect(press(view, 'Escape')).toBe(true);
    expect(document.querySelector('.emoji-suggestions')).toBeNull();
    expect(press(view, 'Enter')).toBe(false);
  });
  it.each(['` :sm`', '[ :sm](https://example.com)', '$ :sm$'])(
    'does not activate semantic completion inside %s',
    (markdown) => {
      const view = semantic(markdown);
      // 将光标放在原文查询后；公式为原子节点，不接受实际正文输入。
      const index = view.state.doc.textContent.indexOf(':sm');
      if (index < 0) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, index + 4)));
      type(view, 'i');
      expect(loadEmojiCatalog).not.toHaveBeenCalled();
    },
  );
  it('discards an asynchronous result after a cursor move or view destruction', async () => {
    let resolve!: (value: typeof catalog) => void;
    vi.mocked(loadEmojiCatalog).mockImplementation(() => new Promise((done) => (resolve = done)));
    const view = semantic(':sm');
    type(view, 'i');
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.selection.head - 1),
      ),
    );
    resolve(catalog);
    await Promise.resolve();
    expect(document.querySelector('.emoji-suggestions')).toBeNull();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    type(view, ' :sm');
    type(view, 'i');
    view.destroy();
    resolve(catalog);
    await Promise.resolve();
    expect(document.querySelector('.emoji-suggestions')).toBeNull();
  });
  it('does not consume Enter or Tab when loading fails or there are no matches', async () => {
    vi.mocked(loadEmojiCatalog).mockRejectedValue(new Error('offline'));
    const view = semantic(':sm');
    type(view, 'i');
    await waitFor(() =>
      expect(document.querySelector('.emoji-suggestions')?.textContent).toContain('retry'),
    );
    expect(press(view, 'Enter')).toBe(false);
    expect(press(view, 'Tab')).toBe(false);
    vi.mocked(loadEmojiCatalog).mockResolvedValue(catalog);
    type(view, 'notfound');
    await waitFor(() =>
      expect(document.querySelector('.emoji-suggestions')?.textContent).toContain('No emoji'),
    );
    expect(press(view, 'Enter')).toBe(false);
  });
  it('uses the public pure-text command with an independent undo step', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = createEditorCore({ markdown: 'one two', target: host });
    disposers.push(() => {
      core.destroy();
      host.remove();
    });
    core.restoreSelectionSnapshot({ anchor: 5, head: 8 });
    expect(core.execute({ type: 'insertText', text: '😄' })).toBe(true);
    expect(core.getMarkdown()).toBe('one 😄');
    core.execute({ type: 'undo' });
    expect(core.getMarkdown()).toBe('one two');
    core.execute({ type: 'redo' });
    expect(core.getMarkdown()).toBe('one 😄');
    core.updateOptions({ readonly: true });
    expect(core.execute({ type: 'insertText', text: '❤️' })).toBe(false);
  });
  it('retains surrounding inline formatting through insertion, undo and redo', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = createEditorCore({ markdown: '**hello**', target: host });
    disposers.push(() => {
      core.destroy();
      host.remove();
    });
    core.restoreSelectionSnapshot({ anchor: 3, head: 8 });
    expect(core.execute({ type: 'insertText', text: '😄' })).toBe(true);
    expect(core.getMarkdown()).toBe('**😄**');
    core.execute({ type: 'undo' });
    expect(core.getMarkdown()).toBe('**hello**');
    core.execute({ type: 'redo' });
    expect(core.getMarkdown()).toBe('**😄**');
  });
  it('completes Chinese source queries and rejects stale range replacements', async () => {
    let handle!: MarkdownSourceEditorHandle;
    const changed = vi.fn();
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown: 'hi :开',
        onReady: (value) => (handle = value),
        onMarkdownChange: changed,
      },
    });
    const view = SourceView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 10, bottom: 30 });
    handle.setSelection(5);
    handle.focus();
    view.dispatch({
      changes: { from: 5, insert: '心' },
      selection: { anchor: 6 },
      userEvent: 'input.type',
    });
    await waitFor(() => expect(document.querySelector('.emoji-suggestion')).not.toBeNull());
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(handle.getMarkdown()).toBe('hi 😄');
    expect(changed).toHaveBeenCalledWith('hi 😄');
    handle.undo();
    expect(handle.getMarkdown()).toBe('hi :开心');
    handle.redo();
    expect(handle.getMarkdown()).toBe('hi 😄');
    const snapshot = handle.getSelectionStatsSnapshot!();
    expect(handle.replaceRange!(0, 2, 'hello', snapshot.contentRevision - 1)).toBe(false);
    expect(handle.replaceRange!(0, 2, 'hello', snapshot.contentRevision)).toBe(true);
    handle.undo();
    expect(handle.getMarkdown()).toBe('hi 😄');
  });
  it('virtualizes the picker, searches both languages and chooses using the keyboard', async () => {
    vi.mocked(loadEmojiCatalog).mockResolvedValue(
      Array.from({ length: 2000 }, (_, index) => ({
        ...catalog[0],
        id: String(index),
        order: index,
      })),
    );
    const choose = vi.fn();
    const close = vi.fn();
    const rendered = render(EmojiPicker, {
      props: {
        interfaceLocale: 'en-US',
        anchor: { left: 10, top: 10, bottom: 30 },
        onChoose: choose,
        onClose: close,
      },
    });
    await waitFor(() =>
      expect(rendered.container.querySelectorAll('.emoji-grid button')).toHaveLength(80),
    );
    const input = rendered.container.querySelector('input')!;
    await fireEvent.input(input, { target: { value: '开心' } });
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    await fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ unicode: '😄' }));
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
});
