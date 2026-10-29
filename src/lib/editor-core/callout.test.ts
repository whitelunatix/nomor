import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { createEditorCore } from './createEditorCore';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { createCalloutPlugin } from './callout/calloutPlugin';
import { removeEmptyCalloutOnBackspace } from './callout/calloutCommands';

describe('callout', () => {
  it('parses GitHub alert syntax into a callout node', () => {
    const doc = parseMarkdown('> [!NOTE]\n> 内容');

    expect(doc.child(0).type.name).toBe('callout');
    expect(doc.child(0).attrs.type).toBe('note');
    expect(doc.child(0).textContent).toBe('内容');
  });

  it('serializes callout nodes back to GitHub alert syntax', () => {
    const markdown = serializeMarkdown(parseMarkdown('> [!WARNING]\n> 注意内容')).trim();

    expect(markdown).toBe('> [!WARNING]\n> 注意内容');
  });

  it('keeps an empty callout inserted from the toolbar command', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown: '', target });

    expect(editor.execute({ type: 'insertCallout' })).toBe(true);
    expect(editor.getMarkdown()).toContain('> [!NOTE]');
    expect(target.querySelector('.callout-card')).not.toBeNull();

    editor.destroy();
    target.remove();
  });

  it('keeps the callout after deleting the last character and removes it on the next Backspace', () => {
    const doc = parseMarkdown('> [!NOTE]\n> A');
    const textPos = 2;
    let state = EditorState.create({
      doc,
      plugins: [createCalloutPlugin()],
    });

    state = state.apply(state.tr.delete(textPos, textPos + 1));

    expect(state.doc.child(0).type.name).toBe('callout');
    expect(state.doc.child(0).textContent).toBe('');
    expect(state.doc.child(0).childCount).toBe(1);

    const didRemove = removeEmptyCalloutOnBackspace(state, (tr) => {
      state = state.apply(tr);
    });

    expect(didRemove).toBe(true);
    expect(state.doc.child(0).type.name).toBe('paragraph');
    expect(state.doc.child(0).textContent).toBe('');
    expect(state.doc.childCount).toBe(1);
  });

  it('parses and serializes a custom title with a fold marker', () => {
    const source = '> [!TIP]+ 自定义标题\n> 内容';
    const doc = parseMarkdown(source);

    expect(doc.child(0).attrs).toMatchObject({ type: 'tip', title: '自定义标题', fold: 'open' });
    expect(doc.child(0).textContent).toBe('内容');
    expect(serializeMarkdown(doc).trim()).toBe(source);
  });

  it('round-trips the collapsed fold marker', () => {
    const doc = parseMarkdown('> [!WARNING]-\n> 内容');

    expect(doc.child(0).attrs.fold).toBe('closed');
    expect(doc.child(0).attrs.title).toBeNull();
    expect(serializeMarkdown(doc).trim()).toBe('> [!WARNING]-\n> 内容');
  });

  it('keeps the marker line as body when the title is not separated by whitespace', () => {
    const doc = parseMarkdown('> [!NOTE]内容');

    expect(doc.child(0).attrs.title).toBeNull();
    expect(doc.child(0).textContent).toBe('内容');
  });

  it.each(['INFO', 'SUCCESS', 'QUESTION', 'DANGER'])('supports the extended %s type', (type) => {
    const doc = parseMarkdown(`> [!${type}]\n> 内容`);

    expect(doc.child(0).attrs.type).toBe(type.toLowerCase());
    expect(serializeMarkdown(doc).trim()).toBe(`> [!${type}]\n> 内容`);
  });

  it('toggles the fold state from the node view', async () => {
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown: '> [!NOTE]-\n> 内容', target });
    // 挂载后的第一帧会暂时禁用编辑，等状态恢复后再模拟点击。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const card = target.querySelector<HTMLElement>('.callout-card');
    const button = target.querySelector<HTMLButtonElement>('.callout-fold-btn');
    expect(card?.classList.contains('is-folded')).toBe(true);
    expect(button?.hidden).toBe(false);

    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editor.getMarkdown()).toContain('> [!NOTE]+');
    expect(card?.classList.contains('is-folded')).toBe(false);

    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(editor.getMarkdown()).toContain('> [!NOTE]-');
    expect(card?.classList.contains('is-folded')).toBe(true);

    editor.destroy();
    target.remove();
  });

  it('renders a custom title and hides the fold button without fold syntax', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown: '> [!TIP] 自定义标题\n> 内容', target });

    expect(target.querySelector('.callout-title')?.textContent).toBe('自定义标题');
    expect(target.querySelector<HTMLButtonElement>('.callout-fold-btn')?.hidden).toBe(true);

    editor.destroy();
    target.remove();
  });

  it('opens the type picker and applies the selected callout type', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown: '', target });

    editor.execute({ type: 'insertCallout' });
    const button = target.querySelector<HTMLButtonElement>('.callout-type-btn');
    expect(button).not.toBeNull();
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    const callout = target.querySelector('.callout-card');
    expect(callout?.classList.contains('is-picker-open')).toBe(true);

    const picker = target.querySelector('.callout-type-picker');
    expect(picker).not.toBeNull();

    const tipItem = target.querySelector<HTMLElement>(
      '.callout-type-picker-item[data-callout-type="tip"]',
    );
    tipItem?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(editor.getMarkdown()).toContain('> [!TIP]');
    expect(callout?.classList.contains('is-picker-open')).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    editor.destroy();
    target.remove();
  });
});
