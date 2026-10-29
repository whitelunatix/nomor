import { afterEach, describe, expect, it } from 'vitest';
import { history, redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { parseMarkdown } from '../markdown';
import { schema } from '../schema';
import { tableHtmlBlockPlugin } from './tableHtml';

const html = '<p align="center"><a href="./README.md"><img src="https://img.shields.io/badge/test-blue" alt="Badge"></a> Preview</p>';
const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function mount(state: EditorState): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const view = new EditorView(host, { state });
  views.push(view);
  return view;
}

function createView(markdown: string): EditorView {
  return mount(EditorState.create({
    doc: parseMarkdown(markdown),
    plugins: [tableHtmlBlockPlugin(), history()],
  }));
}

function widgets(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>('.html-widget'));
}

afterEach(() => {
  for (const view of views.splice(0)) {
    if (!view.isDestroyed) view.destroy();
  }
  for (const host of hosts.splice(0)) host.remove();
});

describe('HTML fallback previews', () => {
  it('preserves preview markup and image DOM while typing before and after the HTML block', () => {
    const view = createView(`Before\n\n${html}\n\nAfter`);
    const [preview] = widgets(view);
    const image = preview.querySelector('img');
    const markup = preview.outerHTML;

    for (const paragraph of ['Before', 'After']) {
      let position = 0;
      view.state.doc.forEach((node, pos) => {
        if (node.textContent.startsWith(paragraph)) position = pos + 1 + node.content.size;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      for (const character of ['a', '中']) {
        view.dispatch(view.state.tr.insertText(character));
        expect(widgets(view)).toEqual([preview]);
        expect(widgets(view)[0]).toBe(preview);
        expect(preview.querySelector('img')).toBe(image);
        expect(preview.outerHTML).toBe(markup);
      }
    }
  });

  it('keeps the same preview when blocks are inserted and removed before it', () => {
    const view = createView(`Before\n\n${html}\n\nAfter`);
    const [preview] = widgets(view);
    const paragraph = schema.nodes.paragraph.create(null, schema.text('Inserted'));

    view.dispatch(view.state.tr.insert(0, paragraph));
    expect(widgets(view)[0]).toBe(preview);
    view.dispatch(view.state.tr.delete(0, paragraph.nodeSize));
    expect(widgets(view)[0]).toBe(preview);
  });

  it('updates only the changed preview when identical HTML blocks coexist', () => {
    const view = createView(`${html}\n\n${html}\n\nAfter`);
    const [first, second] = widgets(view);
    expect(first).not.toBe(second);
    const from = 1 + view.state.doc.firstChild!.textContent.indexOf('Preview');

    view.dispatch(view.state.tr.insertText('Updated', from, from + 'Preview'.length));

    const [updated, unchanged] = widgets(view);
    expect(updated).not.toBe(first);
    expect(updated.textContent?.trim()).toBe('Updated');
    expect(updated.classList.contains('html-widget-aligned-paragraph')).toBe(true);
    expect(updated.style.textAlign).toBe('center');
    expect(updated.style.whiteSpace).toBe('normal');
    expect(unchanged).toBe(second);
    expect(second.textContent?.trim()).toBe('Preview');
  });

  it('removes deleted previews and restores them through undo and redo', () => {
    const view = createView(`${html}\n\nAfter`);
    view.dispatch(view.state.tr.delete(0, view.state.doc.firstChild!.nodeSize));
    expect(widgets(view)).toHaveLength(0);

    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(widgets(view)).toHaveLength(1);
    expect(widgets(view)[0].textContent?.trim()).toBe('Preview');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(widgets(view)).toHaveLength(0);
  });

  it('shows plain text when a block no longer contains fallback HTML', () => {
    const view = createView(`${html}\n\nAfter`);
    view.dispatch(view.state.tr.insertText('Plain text', 1, view.state.doc.firstChild!.nodeSize - 1));

    expect(widgets(view)).toHaveLength(0);
    expect(view.dom.querySelector('p')?.textContent).toBe('Plain text');
    expect(view.dom.querySelector('[style*="display: none"]')).toBeNull();
  });

  it('creates fresh preview DOM when a retained editor state is remounted', () => {
    const view = createView(`${html}\n\nAfter`);
    const [original] = widgets(view);
    const markup = original.outerHTML;
    const retainedState = view.state;
    view.destroy();
    const restored = mount(retainedState);
    const [preview] = widgets(restored);

    expect(original.isConnected).toBe(false);
    expect(preview).not.toBe(original);
    expect(preview.outerHTML).toBe(markup);
    expect(preview.querySelector('img')).not.toBe(original.querySelector('img'));
  });
});
