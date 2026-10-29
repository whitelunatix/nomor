import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { setSourceSearchHighlights, sourceSearchHighlights } from './sourceSearchHighlights';

function createView(doc: string): { host: HTMLElement; view: EditorView } {
  const host = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [sourceSearchHighlights()] }),
    parent: host,
  });
  return { host, view };
}

function highlight(
  view: EditorView,
  matches: Array<{ from: number; to: number }>,
  activeIndex: number,
) {
  view.dispatch({ effects: setSourceSearchHighlights.of({ matches, activeIndex }) });
}

describe('sourceSearchHighlights', () => {
  it('marks every match and highlights the active one separately', () => {
    const { host, view } = createView('管理与管理\n管理');
    const matches = [
      { from: 0, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 8 },
    ];

    highlight(view, matches, 1);

    expect(host.querySelectorAll('.search-match')).toHaveLength(2);
    expect(host.querySelectorAll('.search-match-active')).toHaveLength(1);
    expect(host.querySelector('.search-match-active')?.textContent).toBe('管理');

    view.destroy();
    host.remove();
  });

  it('keeps decorations aligned when the document changes', () => {
    const { host, view } = createView('管理与管理');

    highlight(view, [{ from: 3, to: 5 }], 0);
    expect(host.querySelectorAll('.search-match-active')).toHaveLength(1);

    view.dispatch({ changes: { from: 0, to: 0, insert: '前文' } });

    const active = host.querySelector('.search-match-active');
    expect(active?.textContent).toBe('管理');
    expect(view.state.doc.toString()).toBe('前文管理与管理');

    view.destroy();
    host.remove();
  });

  it('clears all highlights when the match list is empty', () => {
    const { host, view } = createView('管理与管理');

    highlight(view, [{ from: 0, to: 2 }], 0);
    expect(host.querySelectorAll('.search-match-active')).toHaveLength(1);

    highlight(view, [], 0);
    expect(host.querySelectorAll('.search-match, .search-match-active')).toHaveLength(0);

    view.destroy();
    host.remove();
  });

  it('drops matches that fall outside the current document', () => {
    const { host, view } = createView('短文本');

    highlight(view, [{ from: 0, to: 2 }, { from: 90, to: 92 }], 0);
    expect(host.querySelectorAll('.search-match, .search-match-active')).toHaveLength(1);

    view.destroy();
    host.remove();
  });
});
