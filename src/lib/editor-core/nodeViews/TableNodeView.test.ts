import { afterEach, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo } from 'prosemirror-history';
import { parseMarkdown, serializeMarkdown } from '../markdown';
import { TableNodeView, tableLayoutPlugin, flushEditorTableLayout } from './TableNodeView';

let view: EditorView | undefined;
afterEach(async () => {
  view?.destroy();
  view = undefined;
  await Promise.resolve();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('survives state/plugin replacement with retained NodeViews and keeps auto widths out of history/Markdown', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  const initial = parseMarkdown('| A | B | C |\n| --- | --- | --- |\n| a | b | c |');
  const state = (doc: typeof initial) =>
    EditorState.create({ doc, plugins: [tableLayoutPlugin(), history()] });
  const host = document.body.appendChild(document.createElement('div'));
  view = new EditorView(host, {
    state: state(initial),
    nodeViews: { table: (node, view) => new TableNodeView(node, view) },
  });
  await flushEditorTableLayout(view);
  const table = host.querySelector('table')!;
  expect(table.querySelectorAll('col')).toHaveLength(3);
  expect(view.state.doc).toBe(initial);
  expect(undo(view.state)).toBe(false);
  const replacement = parseMarkdown('| X | Y |\n| --- | --- |\n| x | y |');
  view.updateState(state(replacement));
  await Promise.resolve();
  await flushEditorTableLayout(view);
  expect(host.querySelector('table')).toBe(table);
  expect(table.querySelectorAll('col')).toHaveLength(2);
  expect(serializeMarkdown(view.state.doc)).toBe(serializeMarkdown(replacement));
  expect(serializeMarkdown(view.state.doc)).not.toContain('data-colwidth');
  expect(undo(view.state)).toBe(false);
});

it('ignores owned colgroup mutations but forwards content and selection mutations', () => {
  const node = parseMarkdown('| A |\n| --- |\n| text |').firstChild!;
  const host = document.body.appendChild(document.createElement('div'));
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown('test') }),
    plugins: [tableLayoutPlugin()],
  });
  const table = new TableNodeView(node, view);
  const cell = table.contentDOM
    .appendChild(document.createElement('tr'))
    .appendChild(document.createElement('td'));
  expect(table.ignoreMutation({ type: 'selection', target: cell })).toBe(false);
  expect(table.ignoreMutation({ type: 'attributes', target: cell } as unknown as MutationRecord)).toBe(false);
  expect(
    table.ignoreMutation({
      type: 'attributes',
      attributeName: 'style',
      target: table.table,
    } as unknown as MutationRecord),
  ).toBe(true);
  expect(
    table.ignoreMutation({
      type: 'childList',
      target: table.table,
      addedNodes: [table.contentDOM],
      removedNodes: [],
    } as unknown as MutationRecord),
  ).toBe(false);
  table.destroy();
});
