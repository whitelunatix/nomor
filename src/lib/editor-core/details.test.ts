import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, DOMSerializer } from 'prosemirror-model';
import { parseMarkdown, serializeMarkdown, parseMarkdownWithSyncAnchors } from './markdown';
import { schema } from './schema';
import { projectInlineSource } from './InlineSourceCodec';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { detailsIsOpen, setDetailsTemporaryOpen } from './details/detailsState';
import { insertQuickInsertContent } from './editorCommands';

const block = (body = '正文', title = '标题', open = false) =>
  `<details${open ? ' open' : ''}>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;

describe('details source', () => {
  it('retains blank paragraphs inside the body on save', () => {
    const doc = parseMarkdown(block('first\n\n\nsecond'));
    expect(doc.firstChild!.lastChild!.childCount).toBe(3);
    expect(parseMarkdown(serializeMarkdown(doc)).toJSON()).toEqual(doc.toJSON());
  });

  it('keeps Markdown blocks following an HTML paragraph editable', () => {
    const doc = parseMarkdown(block('<p>first</p>\n\n- item\n\n```js\ncode\n```'));
    const names: string[] = [];
    doc.descendants(node => { names.push(node.type.name); });
    expect(names).toContain('bullet_list');
    expect(names).toContain('code_block');
  });

  it('parses details nested in a second-level list', () => {
    const nested = '- outer\n\n  - child\n\n' + block('inside').split('\n').map(line => '    ' + line).join('\n');
    const doc = parseMarkdown(block(nested));
    let count = 0;
    doc.descendants(node => { if (node.type.name === 'details') count++; });
    expect(count).toBe(2);
    expect(parseMarkdown(serializeMarkdown(doc)).toJSON()).toEqual(doc.toJSON());
  });

  it('round trips a details block as the first child of a nested list item', () => {
    const nested = '- outer\n\n  - ' + block('inside').split('\n').map((line, index) => index ? '    ' + line : line).join('\n');
    const doc = parseMarkdown(block(nested));
    let count = 0;
    doc.descendants(node => { if (node.type.name === 'details') count++; });
    expect(count).toBe(2);
    expect(parseMarkdown(serializeMarkdown(doc)).toJSON()).toEqual(doc.toJSON());
  });

  it('retains leading and trailing empty body paragraphs', () => {
    const paragraph = (text = '') => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
    const doc = schema.nodes.doc.create(null, schema.nodes.details.create(null, [
      schema.nodes.details_summary.create(null, schema.text('title')),
      schema.nodes.details_body.create(null, [paragraph(), paragraph('body'), paragraph(), paragraph()]),
    ]));
    expect(projectInlineSource(parseMarkdown(serializeMarkdown(doc))).toJSON(), serializeMarkdown(doc)).toEqual(doc.toJSON());
  });

  it('does not pair inline backticks across a block boundary', () => {
    const doc = parseMarkdown(block('unmatched `tick') + '\n\noutside `tick');
    expect(doc.firstChild?.type.name).toBe('details');
    expect(doc.childCount).toBe(2);
  });
  it('round trips rich summary, paragraphs, lists, code, image and nested details', () => {
    const source = block(`第一段\n\n- 列表\n\n\`\`\`html\n</details>\n\`\`\`\n\n![图片](a.png)\n\n${block('嵌套正文', '内层', true)}`,
      '<strong>标题</strong> <em>强调</em> <code>x &lt; y</code> <a href="https://example.com">链接</a>');
    const doc = parseMarkdown(source);
    expect(doc.firstChild?.type.name).toBe('details');
    const serialized = serializeMarkdown(doc);
    const again = parseMarkdown(serialized);
    expect(again.toJSON()).toEqual(doc.toJSON());
    expect(serialized).toContain('```html\n</details>\n```');
    expect(serialized).toContain('<details open>');
  });

  it('parses complete HTML bodies and boolean open attributes', () => {
    const doc = parseMarkdown('<details open="false"><summary><b>标题</b></summary><p>正文</p><ol start="3"><li><p>项</p></li></ol><pre><code class="language-js">a &lt; b\n\nnext</code></pre><p><img src="a.png" width="60%"></p></details>');
    expect(doc.firstChild?.attrs.defaultOpen).toBe(true);
    expect(serializeMarkdown(doc)).toContain('```js');
    expect(projectInlineSource(parseMarkdown(serializeMarkdown(doc))).toJSON()).toEqual(projectInlineSource(doc).toJSON());
  });

  it('keeps unsafe, unsupported and unclosed HTML as source', () => {
    for (const source of [block('text').replace('<details>', '<details onclick="evil()">'),
      block('<p style="color:red">body</p>'), block('body', '<a id="anchor"></a>'),
      block('body', '<p>one</p><p>two</p>'), '<details>\n<summary>title</summary>\n\nbody']) {
      expect(parseMarkdown(source).firstChild?.type.name).not.toBe('details');
      expect(serializeMarkdown(parseMarkdown(source))).toContain('<details');
    }
  });

  it('supports quote/list containers and maps body source lines', () => {
    for (const source of [block().split('\n').map(line => `> ${line}`).join('\n'),
      '- item\n\n' + block().split('\n').map(line => `  ${line}`).join('\n')]) {
      const doc = parseMarkdown(source);
      const found: string[] = [];
      doc.descendants(node => { if (node.type.name === 'details') found.push(node.type.name); });
      expect(found).toHaveLength(1);
      expect(parseMarkdown(serializeMarkdown(doc)).toJSON(), serializeMarkdown(doc)).toEqual(doc.toJSON());
    }
    expect(parseMarkdownWithSyncAnchors(block()).anchors.some(a => a.kind === 'paragraph' && a.fromLine === 4)).toBe(true);
  });

  it('copies and imports semantic HTML with default state and code language', () => {
    const doc = projectInlineSource(parseMarkdown(block('```ts\nlet a = 1\n```')));
    const root = document.createElement('div');
    root.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(false);
    const parsed = DOMParser.fromSchema(schema).parse(root);
    expect(parsed.firstChild?.type.name).toBe('details');
    expect(parsed.textContent).toBe(doc.textContent);
    expect(parsed.firstChild?.lastChild?.firstChild?.attrs.params).toBe('ts');
  });

  it('does not close at literal tags inside nested fences, comments or escaped text', () => {
    for (const body of [
      '> ```html\n> </details>\n> ```',
      '- ```html\n  </details>\n  ```',
      '`</details>` and \\</details>',
      '<!--\n</details>\n-->\n\nafter',
      '> ```html\n> </details>\n\nafter',
    ]) {
      const doc = parseMarkdown(block(body));
      expect(doc.firstChild?.type.name).toBe('details');
      expect(doc.childCount).toBe(1);
      expect(parseMarkdown(serializeMarkdown(doc)).toJSON(), serializeMarkdown(doc)).toEqual(doc.toJSON());
    }
  });
});

const editors: EditorCore[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); document.body.replaceChildren(); });
function editorFixture(markdown = block()) {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = createEditorCore({ markdown, target: root });
  editors.push(editor);
  const view = () => (editor as unknown as { view: EditorView }).view;
  view().setProps({ editable: () => true });
  const select = (pos: number) => view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, pos)));
  const key = (key: string, modifiers: KeyboardEventInit = {}) => view().dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
  return { editor, root, view, select, key };
}

describe('details editing', () => {
  it('skips collapsed content on ArrowUp from the middle of the following first line', () => {
    const f = editorFixture(block() + '\n\nafter');
    const node = f.view().state.doc.firstChild!;
    f.select(node.nodeSize + 3);
    vi.spyOn(f.view(), 'endOfTextblock').mockReturnValue(true);
    f.key('ArrowUp');
    expect(f.view().state.selection.from).toBe(2 + node.firstChild!.content.size);
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
  });

  it('separates insertion and subsequent normal typing in undo history', () => {
    const f = editorFixture('');
    f.editor.execute({ type: 'insertDetails' });
    f.view().dispatch(f.view().state.tr.insertText('typed'));
    f.editor.execute({ type: 'undo' });
    expect(f.view().state.doc.firstChild?.type.name).toBe('details');
    expect(f.view().state.doc.firstChild?.firstChild?.textContent).toBe('');
  });

  it('keeps default changes and unwrap separate from following typing and redoes each step', () => {
    for (const type of ['setDetailsDefaultOpen', 'unwrapDetails'] as const) {
      const f = editorFixture();
      f.select(2);
      f.editor.execute(type === 'setDetailsDefaultOpen' ? { type, open: true } : { type });
      const structural = f.editor.getMarkdown();
      f.view().dispatch(f.view().state.tr.insertText('typed'));
      const typed = f.editor.getMarkdown();
      f.editor.execute({ type: 'undo' });
      expect(f.editor.getMarkdown()).toBe(structural);
      f.editor.execute({ type: 'undo' });
      expect(f.editor.getMarkdown()).toBe(block());
      f.editor.execute({ type: 'redo' });
      expect(f.editor.getMarkdown()).toBe(structural);
      f.editor.execute({ type: 'redo' });
      expect(f.editor.getMarkdown()).toBe(typed);
    }
  });

  it('does not leak a temporary override to a different restored snapshot', () => {
    const f = editorFixture();
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, 0, true));
    f.editor.restoreSnapshot({ ...f.editor.getSnapshot(), markdown: block('replacement', 'different'), selection: { anchor: 2, head: 2 } });
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
  });

  it('keeps an override on the original block when source inserts a same-title block before it', () => {
    const original = block('original');
    const f = editorFixture(original);
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, 0, true));
    f.editor.setMarkdown(block('inserted') + '\n\n' + original, { sourceInput: true });
    f.editor.updateOptions({ mode: 'semantic' });
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    expect(detailsIsOpen(f.view().state, f.view().state.doc.firstChild!.nodeSize)).toBe(true);
  });

  it('resets ambiguous source duplicates instead of assigning the old override to a new block', () => {
    const original = block('same');
    const f = editorFixture(original);
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, 0, true));
    f.editor.setMarkdown(original + '\n\n' + original, { sourceInput: true });
    f.editor.updateOptions({ mode: 'semantic' });
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    expect(detailsIsOpen(f.view().state, f.view().state.doc.firstChild!.nodeSize)).toBe(false);
  });

  it('does not share a temporary override between HTML nodes with the same coarse source range', () => {
    const source = '<details><summary>outer</summary><p>before</p><details><summary>inner one</summary><p>one</p></details><details><summary>inner two</summary><p>two</p></details></details>';
    const f = editorFixture(source);
    const positions: number[] = [];
    f.view().state.doc.descendants((node, pos) => { if (node.type.name === 'details') positions.push(pos); });
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, positions[2], true));
    f.editor.setMarkdown(source + '\n\nafter', { sourceInput: true });
    f.editor.updateOptions({ mode: 'semantic' });
    expect(detailsIsOpen(f.view().state, positions[0])).toBe(false);
    expect(detailsIsOpen(f.view().state, positions[1])).toBe(false);
  });
  it('inserts one undoable block, focuses title and only temporarily opens it', () => {
    const f = editorFixture('');
    expect(f.editor.execute({ type: 'insertDetails' })).toBe(true);
    expect(f.view().state.selection.$from.parent.type.name).toBe('details_summary');
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    expect(f.editor.getMarkdown()).not.toContain('<details open>');
    expect(f.editor.execute({ type: 'undo' })).toBe(true);
    expect(f.editor.getMarkdown()).toBe('');
    expect(f.editor.execute({ type: 'redo' })).toBe(true);
    expect(f.view().state.doc.firstChild?.type.name).toBe('details');
  });

  it('temporary toggles preserve text, dirty state, revision and history', async () => {
    const f = editorFixture();
    const before = f.editor.getSnapshot();
    f.root.querySelector<HTMLButtonElement>('.details-toggle')!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    expect(f.editor.getSnapshot()).toEqual(before);
    expect(f.editor.execute({ type: 'undo' })).toBe(false);
    expect(f.root.querySelector('.details-block')?.getAttribute('data-details-open')).toBe('true');
    expect(f.root.querySelector('.details-toggle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('default state is saved and undoable independently of temporary state', () => {
    const f = editorFixture();
    f.select(2);
    expect(f.editor.execute({ type: 'setDetailsDefaultOpen', open: true })).toBe(true);
    expect(f.editor.getMarkdown()).toContain('<details open>');
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, 0, false));
    expect(f.editor.getMarkdown()).toContain('<details open>');
    f.editor.execute({ type: 'undo' });
    expect(f.editor.getMarkdown()).not.toContain('<details open>');
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    f.editor.execute({ type: 'redo' });
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
  });

  it('retains session overrides across unmount, mode switch and source edits without sharing identical titles', () => {
    const source = block('first') + '\n\n' + block('second');
    const f = editorFixture(source);
    const secondPos = f.view().state.doc.child(0).nodeSize;
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, secondPos, true));
    f.editor.unmount(); f.editor.mount(f.root);
    expect(detailsIsOpen(f.view().state, secondPos)).toBe(true);
    f.editor.updateOptions({ mode: 'source' });
    f.editor.setMarkdown('prefix\n\n' + source, { sourceInput: true, reason: 'source-input' });
    f.editor.updateOptions({ mode: 'semantic' });
    const positions: number[] = [];
    f.view().state.doc.descendants((node, pos) => { if (node.type.name === 'details') positions.push(pos); });
    expect(detailsIsOpen(f.view().state, positions[0])).toBe(false);
    expect(detailsIsOpen(f.view().state, positions[1])).toBe(true);
    const next = f.editor.getMarkdown();
    f.editor.setMarkdown(next.replace('second', 'changed again'), { sourceInput: true });
    f.editor.updateOptions({ mode: 'semantic' });
    expect(detailsIsOpen(f.view().state, positions[1])).toBe(true);
    const reopened = editorFixture(f.editor.getMarkdown());
    expect(detailsIsOpen(reopened.view().state, positions[1])).toBe(false);
  });

  it('enters body, exits an empty trailing paragraph, and unwraps without losing text', () => {
    const f = editorFixture(block('', '标题'));
    f.select(2); f.key('Enter');
    expect(f.view().state.selection.$from.parent.type.name).toBe('paragraph');
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    f.key('Enter');
    expect(f.view().state.selection.$from.depth).toBe(1);
    f.select(2);
    f.editor.execute({ type: 'unwrapDetails' });
    expect(f.view().state.doc.firstChild?.type.name).toBe('paragraph');
    expect(f.view().state.doc.textContent).toBe('标题');
    f.editor.execute({ type: 'undo' });
    expect(f.view().state.doc.firstChild?.type.name).toBe('details');
  });

  it('protects summary structure and exposes hidden body selections', () => {
    const f = editorFixture();
    f.select(2);
    expect(f.editor.execute({ type: 'insertImage', src: 'a.png' })).toBe(false);
    expect(f.editor.execute({ type: 'setHeading', level: 1 })).toBe(false);
    const original = f.editor.getMarkdown();
    for (const key of ['a', 'k', 'm', 'q', 'x', '[', ']']) f.key(key, { ctrlKey: true, shiftKey: true });
    expect(f.editor.getMarkdown()).toBe(original);
    f.key('Backspace');
    expect(f.view().state.doc.firstChild?.type.name).toBe('details');
    const bodyPos = 1 + f.view().state.doc.firstChild!.firstChild!.nodeSize + 2;
    f.select(bodyPos);
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    f.key('Backspace');
    expect(f.view().state.selection.$from.parent.type.name).toBe('details_summary');
  });

  it('quick insert removes trigger and focuses title in one undo step', () => {
    const f = editorFixture('/');
    f.select(2);
    expect(insertQuickInsertContent(f.view(), 1, 2, { type: 'insertDetails' })).toBe(true);
    expect(f.view().state.selection.$from.parent.type.name).toBe('details_summary');
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    f.editor.execute({ type: 'undo' });
    expect(f.editor.getMarkdown()).toBe('/');
  });

  it('keeps rich title editing history through tab remount', () => {
    const f = editorFixture(block('body', '<strong>title</strong>'));
    f.select(2);
    f.editor.execute({ type: 'insertText', text: 'new ' });
    const changed = f.editor.getMarkdown();
    f.editor.unmount(); f.editor.mount(f.root);
    expect(f.editor.getMarkdown()).toBe(changed);
    expect(f.editor.execute({ type: 'undo' })).toBe(true);
    expect(f.editor.getMarkdown()).not.toContain('new ');
    expect(f.editor.getMarkdown()).toContain('<strong>title</strong>');
  });

  it('keeps nested defaults and all body content through HTML paste', () => {
    const f = editorFixture('');
    const html = '<details open><summary><strong>outer</strong></summary><p>before</p><details><summary>inner</summary><pre><code class="language-ts">let a=1</code></pre><p><img src="a.png" width="200" alt="pic"></p></details></details>';
    expect(f.editor.pasteClipboard({ html }).status).toBe('inserted');
    const saved = f.editor.getMarkdown();
    expect(saved).toContain('<details open>');
    expect(saved).toContain('<summary><strong>outer</strong></summary>');
    expect(saved).toContain('```ts');
    expect(saved).toContain('a.png');
    expect(parseMarkdown(saved).firstChild?.lastChild?.childCount).toBe(2);
  });

  it('preserves unsupported clipboard summary content as literal HTML', () => {
    const f = editorFixture('');
    const html = '<details><summary><img src="title.png"></summary><p>body</p></details>';
    expect(f.editor.pasteClipboard({ html }).status).toBe('inserted');
    expect(projectInlineSource(f.view().state.doc).textContent).toContain(html);
    expect(f.view().state.doc.firstChild?.type.name).not.toBe('details');
  });

  it('retains siblings around an imported body wrapper', () => {
    const f = editorFixture('');
    expect(f.editor.pasteClipboard({ html: '<details><summary>title</summary><p>before</p><div data-nomo-details-body><p>inside</p></div><p>after</p></details>' }).status).toBe('inserted');
    expect(f.view().state.doc.firstChild?.lastChild?.textContent).toBe('beforeinsideafter');
  });

  it('preserves title whitespace in semantic HTML copy and paste', () => {
    const doc = projectInlineSource(parseMarkdown(block('body', '  first  second  ')));
    const root = document.createElement('div');
    root.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    const f = editorFixture('');
    f.editor.pasteClipboard({ html: root.innerHTML });
    expect(projectInlineSource(f.view().state.doc).firstChild?.firstChild?.textContent).toBe('  first  second  ');
  });

  it('waits for composition before collapsing a selection that extends outside the body', async () => {
    const f = editorFixture(block() + '\n\nafter');
    const body = f.view().state.doc.firstChild!.firstChild!.nodeSize + 3;
    f.view().dispatch(f.view().state.tr.setSelection(TextSelection.create(f.view().state.doc, body, f.view().state.doc.content.size - 1)));
    let finish!: () => void;
    vi.spyOn(f.editor as unknown as { awaitCompositionEnd(): Promise<void> }, 'awaitCompositionEnd')
      .mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    f.root.querySelector<HTMLButtonElement>('.details-toggle')!.click();
    expect(detailsIsOpen(f.view().state, 0)).toBe(true);
    finish(); await Promise.resolve(); await Promise.resolve();
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    expect(f.view().state.selection.$from.parent.type.name).toBe('details_summary');
  });

  it('keeps four document sessions isolated through repeated remounts and resets on reopen', () => {
    const fixtures = Array.from({ length: 4 }, () => editorFixture());
    fixtures[0].view().dispatch(setDetailsTemporaryOpen(fixtures[0].view().state.tr, 0, true));
    for (let cycle = 0; cycle < 20; cycle++) for (const f of fixtures) {
      f.editor.unmount(); f.editor.mount(f.root);
      expect(detailsIsOpen(f.view().state, 0)).toBe(f === fixtures[0]);
    }
    const saved = fixtures[0].editor.getMarkdown();
    fixtures[0].editor.destroy(); editors.splice(editors.indexOf(fixtures[0].editor), 1);
    const reopened = editorFixture(saved);
    expect(detailsIsOpen(reopened.view().state, 0)).toBe(false);
  });

  it('moves out of the innermost container and does not delete outer text', () => {
    const f = editorFixture(block('before\n\n' + block('inner body') + '\n\nafter'));
    let inner = 0;
    f.view().state.doc.descendants((node, pos) => { if (node.type.name === 'details' && pos > 0) inner = pos; });
    f.select(inner + 2);
    f.key('Enter', { ctrlKey: true });
    expect(f.view().state.selection.$from.node(1).type.name).toBe('details');
    expect(f.view().state.selection.$from.node(2).type.name).toBe('details_body');
    expect(f.view().state.doc.textContent).toContain('after');
    expect(() => f.view().state.doc.check()).not.toThrow();
  });

  it('skips folded body with arrow navigation in both directions', () => {
    const f = editorFixture(block('hidden body') + '\n\nafter');
    const node = f.view().state.doc.firstChild!;
    f.select(2 + node.firstChild!.content.size);
    f.key('ArrowRight');
    expect(f.view().state.selection.from).toBe(node.nodeSize + 1);
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    f.key('ArrowLeft');
    expect(f.view().state.selection.from).toBe(2 + node.firstChild!.content.size);
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    vi.spyOn(f.view(), 'endOfTextblock').mockReturnValue(true);
    f.key('ArrowDown');
    expect(f.view().state.selection.from).toBe(node.nodeSize + 1);
  });

  it('enters a leading code block and commits its draft before folding', async () => {
    const f = editorFixture(block('```ts\nold\n```'));
    f.select(2); f.key('Enter');
    const input = f.root.querySelector<HTMLTextAreaElement>('textarea');
    expect(input).not.toBeNull();
    input!.value = 'new code';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    f.root.querySelector<HTMLButtonElement>('.details-toggle')!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.editor.getMarkdown()).toContain('new code');
    expect(detailsIsOpen(f.view().state, 0)).toBe(false);
    expect(f.view().state.selection.$from.parent.type.name).toBe('details_summary');
  });

  it('keeps multiline paste inside a single summary and preserves whitespace on save', () => {
    const f = editorFixture(block('body', ''));
    f.select(2);
    f.editor.pasteClipboard({ text: 'first\nsecond' }, { mode: 'plain' });
    expect(f.view().state.doc.firstChild!.firstChild!.textContent).toBe('first second');
    f.editor.execute({ type: 'insertText', text: '  more' });
    const saved = f.editor.getMarkdown();
    expect(parseMarkdown(saved).firstChild!.firstChild!.textContent).toBe('first second  more');
    expect(f.view().state.doc.firstChild?.lastChild?.textContent).toBe('body');
  });

  it('maps multiple source changes before reparse and discards deleted block overrides', () => {
    const initial = block('one') + '\n\n' + block('two');
    const f = editorFixture(initial);
    const second = f.view().state.doc.firstChild!.nodeSize;
    f.view().dispatch(setDetailsTemporaryOpen(f.view().state.tr, second, true));
    f.editor.updateOptions({ mode: 'source' });
    f.editor.setMarkdown('before\n\n' + initial, { sourceInput: true });
    f.editor.setMarkdown('before\n\n' + initial.replace('two', 'new two'), { sourceInput: true });
    f.editor.updateOptions({ mode: 'semantic' });
    const positions: number[] = [];
    f.view().state.doc.descendants((node, pos) => { if (node.type.name === 'details') positions.push(pos); });
    expect(detailsIsOpen(f.view().state, positions[1])).toBe(true);
    f.view().dispatch(f.view().state.tr.delete(positions[1], positions[1] + f.view().state.doc.nodeAt(positions[1])!.nodeSize));
    expect(f.root.querySelectorAll('.details-block')).toHaveLength(1);
    expect(detailsIsOpen(f.view().state, positions[0])).toBe(false);
    f.editor.execute({ type: 'undo' });
    expect(f.root.querySelectorAll('.details-block')).toHaveLength(2);
    expect(() => f.view().state.doc.check()).not.toThrow();
  });
});
