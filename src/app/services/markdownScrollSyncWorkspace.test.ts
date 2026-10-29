import { EditorView } from '@codemirror/view';
import { gsap } from 'gsap';
import { cleanup, render } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorCore } from '../../lib/editor-core/createEditorCore';
import MarkdownSourceEditor from '../components/MarkdownSourceEditor.svelte';
import type { MarkdownSourceEditorHandle } from '../components/markdownSourceEditor';
import { syncEditorPanes } from './markdownScrollSyncWorkspace';

const dispose: Array<() => void> = [];
afterEach(() => {
  dispose
    .splice(0)
    .reverse()
    .forEach((destroy) => destroy());
  cleanup();
  vi.restoreAllMocks();
});

const lines = ['# Top', '', 'First', '', '## Middle', '', 'Second', '', '## End'];

describe('workspace scroll synchronization content gate', () => {
  it('waits for source layout and applies only the latest pane intent when measurement completes', () => {
    const f = fixture(lines.join('\r\n'));
    vi.mocked(f.sourceEditor.isLayoutReady!).mockReturnValue(false);
    f.scroll('source', 400);
    expect(f.semantic.scrollTop).toBe(0);
    f.scroll('semantic', 1400);
    expect(f.source.scrollTop).toBe(400);
    vi.mocked(f.sourceEditor.isLayoutReady!).mockReturnValue(true);
    f.grid.dispatchEvent(new Event('nomo:source-layout-change'));
    f.flush();
    expect(f.source.scrollTop).toBeGreaterThan(400);
    expect(f.semantic.scrollTop).toBe(1400);
    expect(f.grid.dataset.syncLeader).toBe('semantic');
  });
  it.each([
    ['LF', lines.join('\n')],
    ['CRLF', lines.join('\r\n')],
    ['mixed LF/CRLF', lines.join('\r\n').replace('\r\n', '\n')],
  ])(
    'follows real source and semantic wheel events with %s without rewriting content',
    (_, markdown) => {
      const f = fixture(markdown);
      const before = f.core.getSnapshot();
      f.sourceEditor.setSelection(2, 4);
      f.sourceEditor.focus();
      const focus = document.activeElement;
      const selection = f.sourceEditor.getSelection();
      const onMarkdownChange = f.onMarkdownChange.mock.calls.length;

      f.scroll('source', 400);
      expect(f.semantic.scrollTop).toBeGreaterThan(0);
      expect(f.source.scrollTop).toBe(400);
      expect(f.grid.dataset.syncStatus).toBe('following');

      f.scroll('semantic', 1400);
      expect(f.source.scrollTop).toBeGreaterThan(400);
      expect(f.semantic.scrollTop).toBe(1400);
      expect(f.grid.dataset.syncLeader).toBe('semantic');
      expect(f.core.getSnapshot()).toEqual(before);
      expect(f.core.getMarkdown()).toBe(markdown);
      expect(f.onMarkdownChange).toHaveBeenCalledTimes(onMarkdownChange);
      expect(document.activeElement).toBe(focus);
      expect(f.sourceEditor.getSelection()).toEqual(selection);
      expect(f.sourceEditor.undo()).toBe(false);
    },
  );

  it('rejects real source differences and resumes the latest intent when only the source catches up', () => {
    const markdown = lines.join('\r\n');
    const f = fixture(markdown);
    // Even one extra space is content, not a line-ending difference.
    f.sourceEditor.setMarkdown(markdown + ' ', { addToHistory: false });
    f.scroll('source', 400);
    expect(f.semantic.scrollTop).toBe(0);
    expect(f.grid.dataset.syncStatus).toBe('waiting-for-content');

    f.sourceEditor.setMarkdown(markdown, { addToHistory: false });
    f.grid.dispatchEvent(new Event('nomo:source-layout-change'));
    f.flush();
    expect(f.semantic.scrollTop).toBeGreaterThan(0);
    expect(f.source.scrollTop).toBe(400);
    expect(f.grid.dataset.syncStatus).toBe('following');

    const previousFollower = f.semantic.scrollTop;
    f.sourceEditor.setMarkdown(markdown + ' ', { addToHistory: false });
    f.scroll('source', 700);
    expect(f.semantic.scrollTop).toBe(previousFollower);
    f.scroll('semantic', 1400);
    expect(f.source.scrollTop).toBe(700);
    expect(f.grid.dataset.syncStatus).toBe('waiting-for-content');
  });

  it('invalidates matching content across pending revisions and document switches', () => {
    const markdown = lines.join('\r\n');
    const f = fixture(markdown);
    f.scroll('source', 400);
    expect(f.grid.dataset.syncStatus).toBe('following');
    const previousFollower = f.semantic.scrollTop;

    const nextMarkdown = markdown.replace('First', 'Changed');
    f.core.setMarkdown(nextMarkdown, { sourceInput: true });
    f.action.update({ ...f.params, markdown: nextMarkdown });
    f.scroll('source', 600);
    expect(f.semantic.scrollTop).toBe(previousFollower);
    expect(f.grid.dataset.syncStatus).toBe('waiting-for-content');

    f.core.refreshSemanticView();
    f.grid.dispatchEvent(new Event('nomo:editor-viewport-layout-refresh'));
    f.flush();
    expect(f.semantic.scrollTop).toBe(previousFollower);
    f.sourceEditor.setMarkdown(nextMarkdown, { addToHistory: false });
    f.grid.dispatchEvent(new Event('nomo:source-layout-change'));
    f.flush();
    expect(f.grid.dataset.syncStatus).toBe('following');
    expect(f.source.scrollTop).toBe(600);
    expect(f.semantic.scrollTop).toBeGreaterThan(previousFollower);

    f.action.update({ ...f.params, documentId: 'second-document' });
    f.flush();
    expect(f.grid.dataset.syncStatus).toBe('waiting-for-content');
    f.action.update({
      ...f.params,
      documentId: 'second-document',
      markdown: nextMarkdown,
    });
    f.flush();
    expect(f.grid.dataset.syncStatus).toBe('following');
    expect(f.grid.dataset.syncRevision).toContain('second-document');
  });
});

function fixture(markdown: string) {
  // 同步队列断言不包含 GSAP 导入时启动的全局 ticker；本场景没有动画。
  gsap.ticker.sleep();
  vi.spyOn(gsap.ticker, 'wake').mockImplementation(() => undefined);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const grid = document.createElement('div');
  grid.innerHTML =
    '<section class="source-pane"></section><section class="semantic-pane"></section>';
  document.body.appendChild(grid);
  const semantic = grid.querySelector<HTMLElement>('.semantic-pane')!;
  let sourceEditor!: MarkdownSourceEditorHandle;
  const onMarkdownChange = vi.fn();
  const rendered = render(MarkdownSourceEditor, {
    target: grid.querySelector<HTMLElement>('.source-pane')!,
    props: {
      markdown,
      sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
      onMarkdownChange,
      onReady: (handle) => (sourceEditor = handle),
    },
  });
  // This is the same external-update path used when opening an existing file.
  sourceEditor.setMarkdown(markdown, { addToHistory: false });
  const source = sourceEditor.getScrollElement();
  const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
  expect(sourceEditor.getMarkdown()).toBe(view.state.doc.toString());
  const core = createEditorCore({ markdown, target: semantic });
  expect(core.getScrollSyncSnapshot().ready).toBe(true);

  // jsdom has no layout. Keep real editors/content/events; substitute only geometry.
  vi.spyOn(
    sourceEditor as MarkdownSourceEditorHandle & { isLayoutReady(): boolean },
    'isLayoutReady',
  ).mockReturnValue(true);
  for (const pane of [source, semantic]) {
    Object.defineProperties(pane, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4000 },
    });
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 600));
  }
  vi.spyOn(sourceEditor, 'getLineTop').mockImplementation((line) => (line - 1) * 200);
  vi.spyOn(sourceEditor, 'getContentHeight').mockReturnValue(1800);
  vi.spyOn(core, 'getScrollSyncAnchorRect').mockImplementation((anchor) => ({
    top: (anchor.fromLine - 1) * 300 - semantic.scrollTop,
    bottom: (anchor.fromLine - 1) * 300 + 100 - semantic.scrollTop,
  }));
  const flush = () => {
    for (let n = 0; frames.size && n < 10; n++) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    }
    expect(frames.size).toBe(0);
  };
  const params = {
    mode: 'split' as const,
    documentId: 'first-document',
    markdown,
    sourceEditor,
    editorCore: core,
    activePane: 'source' as const,
    paused: false,
    largeDocumentMode: false,
  };
  const action = syncEditorPanes(grid, params);
  dispose.push(() => {
    action.destroy();
    core.destroy();
    grid.remove();
  });
  flush();
  const scroll = (pane: 'source' | 'semantic', top: number) => {
    const element = pane === 'source' ? source : semantic;
    const target = pane === 'source' ? view.contentDOM : semantic.querySelector('.ProseMirror')!;
    element.scrollTop = top;
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
    element.dispatchEvent(new Event('scroll'));
    flush();
  };
  return {
    grid,
    core,
    source,
    semantic,
    sourceEditor,
    onMarkdownChange,
    params,
    action,
    scroll,
    flush,
  };
}
