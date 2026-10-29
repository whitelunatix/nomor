import { EditorState as SourceState, StateEffect } from '@codemirror/state';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditorState as SemanticState } from 'prosemirror-state';
import { parseMarkdown, serializeMarkdown } from '../../lib/editor-core/markdown';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { cleanup, render } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownSourceEditor from './MarkdownSourceEditor.svelte';
import type { MarkdownSourceEditorHandle } from './markdownSourceEditor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MarkdownSourceEditor', () => {
  it('places a collapsed caret from viewport coordinates, reports empty selection and keeps undo history', () => {
    let handle!: MarkdownSourceEditorHandle;
    const onSelectionSnapshotChange = vi.fn();
    const { container } = render(MarkdownSourceEditor, { props: {
      markdown: '第一行 hello\n第二行 world', documentId: 'coordinates', onSelectionSnapshotChange,
      onReady: (value) => { handle = value; },
    } });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
    vi.spyOn(view.contentDOM, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 400, 100));
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(4);
    handle.setSelection(1, 16);
    expect(handle.placeCaretAtCoordinates({ left: 650, top: 70 })).toBe(true);
    expect(hit).toHaveBeenCalledWith({ x: 650, y: 70 }, false);
    expect(handle.getSelection()).toEqual({ from: 4, to: 4, anchor: 4, head: 4 });
    expect(onSelectionSnapshotChange).toHaveBeenLastCalledWith({ documentId: 'coordinates', from: 4, to: 4, contentRevision: 0 });
    expect(handle.undo()).toBe(false);
    expect(view.hasFocus).toBe(true);
    handle.placeCaretAtCoordinates({ left: 120, top: 10 });
    expect(handle.getSelection().head).toBe(0);
    handle.placeCaretAtCoordinates({ left: 120, top: 200 });
    expect(handle.getSelection().head).toBe(view.state.doc.length);
    view.dispatch({ changes: { from: view.state.doc.length, insert: '输入' } });
    expect(handle.undo()).toBe(true);
    expect(handle.getMarkdown()).toBe('第一行 hello\n第二行 world');
  });

  it('does not place a caret in readonly, composing or destroyed source views', async () => {
    let handle!: MarkdownSourceEditorHandle;
    const rendered = render(MarkdownSourceEditor, { props: {
      markdown: '正文', readonlyDocumentMode: true, onReady: (value) => { handle = value; },
    } });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    expect(handle.placeCaretAtCoordinates({ left: 100, top: 100 })).toBe(false);
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false');
    await rendered.rerender({ readonlyDocumentMode: false });
    vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
    expect(handle.placeCaretAtCoordinates({ left: 100, top: 100 })).toBe(false);
    rendered.unmount();
    expect(handle.placeCaretAtCoordinates({ left: 100, top: 100 })).toBe(false);
  });

  it('caches history and selection without retaining view callbacks across remounts', () => {
    let handle!: MarkdownSourceEditorHandle;
    const oldChange = vi.fn();
    const first = render(MarkdownSourceEditor, { props: {
      markdown: 'first', documentId: 'retained', onMarkdownChange: oldChange,
      onReady: (value) => { handle = value; },
    } });
    const view = EditorView.findFromDOM(first.container.querySelector('.cm-editor')!)!;
    view.dispatch({ changes: { from: 5, insert: ' edit' }, selection: { anchor: 8 } });
    const saved = handle.getRuntimeState!();
    expect(saved.state.facet(EditorView.updateListener)).toEqual([]);
    const countStyleRules = () => [...document.styleSheets].reduce((count, sheet) => count + sheet.cssRules.length, 0);
    const mountedStyleRules = countStyleRules();
    first.unmount();
    oldChange.mockClear();
    const newChange = vi.fn();
    render(MarkdownSourceEditor, { props: {
      markdown: 'first edit', documentId: 'retained', runtimeState: saved,
      onMarkdownChange: newChange, onReady: (value) => { handle = value; },
    } });
    expect(countStyleRules()).toBe(mountedStyleRules);
    expect(handle.getSelection().from).toBe(8);
    expect(handle.undo()).toBe(true);
    expect(handle.getMarkdown()).toBe('first');
    expect(handle.redo()).toBe(true);
    expect(handle.getMarkdown()).toBe('first edit');
    expect(newChange).toHaveBeenCalled();
    expect(oldChange).not.toHaveBeenCalled();
  });

  it('reports only ranges and revisions without slicing text for snapshot subscribers', () => {
    let handle!: MarkdownSourceEditorHandle;
    const onSelectionSnapshotChange = vi.fn();
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown: '中文 hello', documentId: 'a',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onReady: (value) => (handle = value), onSelectionSnapshotChange,
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    const slice = vi.spyOn(SourceState.prototype, 'sliceDoc');
    handle.setSelection(0, 5);
    expect(onSelectionSnapshotChange).toHaveBeenLastCalledWith({
      documentId: 'a', from: 0, to: 5, contentRevision: 0,
    });
    expect(slice).not.toHaveBeenCalled();
    view.dispatch({ changes: { from: 0, insert: '新' } });
    expect(onSelectionSnapshotChange.mock.lastCall?.[0].contentRevision).toBe(1);
  });
  it.each([
    {
      name: 'a generated long document',
      markdown: Array.from(
        { length: 80 },
        (_, index) =>
          `### Section ${index + 1}\n\nParagraph ${index + 1} keeps a unique viewport anchor while surrounding Markdown is normalized.\n\n* Item ${index + 1}`,
      ).join('\n\n'),
      expectedStableLines: 79,
    },
    ...['README.md', 'sample.md'].map((file) => ({
      name: file,
      markdown: readFileSync(resolve(process.cwd(), file), 'utf8'),
      expectedStableLines: undefined,
    })),
  ])(
    'preserves unchanged viewport anchors through the first semantic edit of $name',
    ({ markdown, expectedStableLines }) => {
      let handle!: MarkdownSourceEditorHandle;
      const onMarkdownChange = vi.fn();
      const rendered = render(MarkdownSourceEditor, {
        props: {
          markdown,
          sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
          onMarkdownChange,
          onReady: (value) => (handle = value),
        },
      });
      const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
      const original = handle.getMarkdown();
      const doc = parseMarkdown(markdown);
      let position = 0;
      doc.descendants((node, pos) => {
        if (
          !position &&
          node.type.name === 'paragraph' &&
          node.textContent.length > 30 &&
          pos > doc.content.size * 0.45
        )
          position = pos + 5;
      });
      expect(position).toBeGreaterThan(0);
      const edited = SemanticState.create({ doc }).tr.insertText('测试', position).doc;
      const next = serializeMarkdown(edited).replace(/\r\n/g, '\n');
      const stableLines = original
        .split('\n')
        .filter(
          (line) =>
            line.length > 40 &&
            original.indexOf(line) === original.lastIndexOf(line) &&
            next.includes(line) &&
            next.indexOf(line) === next.lastIndexOf(line),
        );
      // 大量锚点由固定夹具保证，README/sample 的实际内容不承担行数契约。
      expect(stableLines.length).toBeGreaterThan(0);
      if (expectedStableLines !== undefined) expect(stableLines).toHaveLength(expectedStableLines);
      const selected = stableLines[Math.floor(stableLines.length / 2)];
      handle.setSelection(original.indexOf(selected) + 3, original.indexOf(selected) + 8);
      const updates: ViewUpdate[] = [];
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          EditorView.updateListener.of((update) => {
            if (update.docChanged) updates.push(update);
          }),
        ),
      });
      handle.setMarkdown(next, { addToHistory: false });
      expect(handle.getMarkdown()).toBe(next);
      expect(updates).toHaveLength(1);
      // 这些位置就是 CodeMirror 用于保留选区和视口的文档锚点，而非模拟 scrollTop。
      for (const line of stableLines) {
        expect(updates[0].changes.mapPos(original.indexOf(line) + 3, -1)).toBe(
          next.indexOf(line) + 3,
        );
      }
      expect(handle.getSelection()).toMatchObject({
        from: next.indexOf(selected) + 3,
        to: next.indexOf(selected) + 8,
      });
      expect(onMarkdownChange).not.toHaveBeenCalled();
      expect(handle.undo()).toBe(false);
      handle.setMarkdown(markdown, { addToHistory: false });
      expect(handle.getMarkdown()).toBe(original);
      expect(handle.getSelection()).toMatchObject({
        from: original.indexOf(selected) + 3,
        to: original.indexOf(selected) + 8,
      });
    },
  );

  it('does not replace an unchanged CRLF document when switching focus or receiving props', async () => {
    const markdown = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\r\n');
    let handle!: MarkdownSourceEditorHandle;
    const onMarkdownChange = vi.fn();
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown,
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onMarkdownChange,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    handle.setSelection(300, 310);
    const doc = view.state.doc;
    handle.setMarkdown(markdown, { addToHistory: false });
    handle.setMarkdown(markdown, { addToHistory: false });
    await rendered.rerender({
      markdown: markdown.replace(/\r\n/g, '\n'),
      sourceEditor: handle,
      onMarkdownChange,
      onReady: (value) => (handle = value),
    });
    expect(view.state.doc).toBe(doc);
    expect(handle.getSelection()).toMatchObject({ from: 300, to: 310 });
    expect(handle.getMarkdown()).toBe(view.state.doc.toString());
    expect(onMarkdownChange).not.toHaveBeenCalled();
    expect(handle.undo()).toBe(false);
  });

  it('maps the existing selection and viewport anchor through a small external edit', () => {
    const markdown = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    let handle!: MarkdownSourceEditorHandle;
    const onMarkdownChange = vi.fn();
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown,
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onMarkdownChange,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    const updates: ViewUpdate[] = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) updates.push(update);
        }),
      ),
    });
    handle.setSelection(300, 310);
    const insertion = markdown.indexOf('line 40') + 'line 40'.length;
    const next = markdown.slice(0, insertion) + '中文😀' + markdown.slice(insertion);
    handle.setMarkdown(next, { addToHistory: false });
    expect(handle.getMarkdown()).toBe(next);
    expect(handle.getSelection()).toMatchObject({ from: 300, to: 310 });
    expect(updates).toHaveLength(1);
    expect(updates[0].changes.mapPos(280, -1)).toBe(280);
    expect(updates[0].changes.mapPos(500, -1)).toBe(504);
    expect(onMarkdownChange).not.toHaveBeenCalled();
    expect(handle.undo()).toBe(false);
  });

  it('keeps Unicode characters intact when replacing text sharing surrogate halves', () => {
    let handle!: MarkdownSourceEditorHandle;
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown: 'before 😀 after',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    const ranges: Array<[number, number, string]> = [];
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          update.changes.iterChanges((from, to, _fromB, _toB, inserted) =>
            ranges.push([from, to, inserted.toString()]),
          );
        }),
      ),
    });
    handle.setMarkdown('before 😃 after');
    expect(handle.getMarkdown()).toBe('before 😃 after');
    expect(ranges).toEqual([[7, 9, '😃']]);
  });

  it('publishes layout readiness only after the latest content measurement finishes', async () => {
    let handle!: MarkdownSourceEditorHandle;
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown: 'first',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    await handle.requestMeasure();
    expect(handle.isLayoutReady?.()).toBe(true);
    const requests: NonNullable<Parameters<EditorView['requestMeasure']>[0]>[] = [];
    vi.spyOn(view, 'requestMeasure').mockImplementation((request) => {
      if (request?.write) requests.push(request);
    });
    handle.setMarkdown('second');
    handle.setMarkdown('third');
    expect(handle.isLayoutReady?.()).toBe(false);
    requests[0].write?.(requests[0].read(view), view);
    await Promise.resolve();
    expect(handle.isLayoutReady?.()).toBe(false);
    requests[1].write?.(requests[1].read(view), view);
    expect(handle.isLayoutReady?.()).toBe(false);
    await Promise.resolve();
    expect(handle.isLayoutReady?.()).toBe(true);
  });

  it('synchronizes CodeMirror input and preserves offsets when block spacers change', () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const onMarkdownChange = vi.fn();
    const { container } = render(MarkdownSourceEditor, {
      props: {
        markdown: '# Title\n\nBody',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        readonlyDocumentMode: false,
        onMarkdownChange,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;

    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
    expect(onMarkdownChange).toHaveBeenLastCalledWith('# Title\n\nBody!');
    expect(handle?.getMarkdown()).toBe('# Title\n\nBody!');

    handle?.setSelection(10, 14);
    handle?.applyBlockGaps(
      [
        { key: 'node:0', nodeIndex: 0, fromLine: 1, toLine: 1 },
        { key: 'node:1', nodeIndex: 1, fromLine: 3, toLine: 3 },
      ],
      new Map([
        ['node:0', 28],
        ['node:1', 40],
      ]),
    );
    expect(handle?.getSelection()).toMatchObject({ from: 10, to: 14 });
    expect(handle?.getMarkdown()).toBe('# Title\n\nBody!');
    expect(container.querySelectorAll('.source-block-alignment-spacer')).toHaveLength(1);
    expect(
      (container.querySelector('.source-block-alignment-spacer') as HTMLElement).style.height,
    ).toBe('28px');
  });

  it('excludes scroll-past-end padding from natural block geometry', async () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const { container } = render(MarkdownSourceEditor, {
      props: {
        markdown: '# Title\n\nBody',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        readonlyDocumentMode: false,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
    view.contentDOM.style.paddingBottom = '80px';
    await new Promise<void>((resolve) => {
      view.requestMeasure({
        read: () => undefined,
        write: () => resolve(),
      });
    });

    const scale = view.scaleY;
    const paddingBottom = Number.parseFloat(getComputedStyle(view.contentDOM).paddingBottom);
    expect(view.contentHeight * scale - handle!.getContentHeight()).toBeCloseTo(
      paddingBottom * scale,
      1,
    );
    const geometry = handle!.getBlockGeometry([
      { key: 'node:0', nodeIndex: 0, fromLine: 1, toLine: 1 },
      { key: 'node:1', nodeIndex: 1, fromLine: 3, toLine: 3 },
    ]);
    expect(geometry.at(-1)?.nextTop).toBeCloseTo(handle!.getContentHeight(), 1);
  });

  it('converts CodeMirror screen measurements to scroll coordinates at non-unit zoom', () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const { container } = render(MarkdownSourceEditor, {
      props: {
        markdown: 'one\ntwo\nthree',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;
    const line = view.lineBlockAt(view.state.doc.line(2).from);
    vi.spyOn(view, 'scaleY', 'get').mockReturnValue(1.5);
    vi.spyOn(view, 'documentPadding', 'get').mockReturnValue({ top: 30, bottom: 45 });
    vi.spyOn(view, 'contentHeight', 'get').mockReturnValue(375);
    vi.spyOn(view, 'lineBlockAt').mockReturnValue({ ...line, top: 60 } as typeof line);
    const heightLookup = vi.spyOn(view, 'lineBlockAtHeight').mockReturnValue(line);
    expect(handle!.getLineTop(2)).toBe(60);
    expect(handle!.getContentHeight()).toBe(200);
    expect(handle!.lineAtHeight(60)).toBe(2);
    expect(heightLookup).toHaveBeenCalledWith(60);
  });

  it('keeps external synchronization out of history and supports source undo/redo', () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const { container } = render(MarkdownSourceEditor, {
      props: {
        markdown: 'alpha',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        readonlyDocumentMode: false,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;

    handle?.setMarkdown('external', { addToHistory: false });
    view.dispatch({ changes: { from: 8, insert: ' edit' } });
    expect(handle?.getMarkdown()).toBe('external edit');
    expect(handle?.undo()).toBe(true);
    expect(handle?.getMarkdown()).toBe('external');
    expect(handle?.redo()).toBe(true);
    expect(handle?.getMarkdown()).toBe('external edit');
  });

  it('reads and restores selections and line offsets', () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    render(MarkdownSourceEditor, {
      props: {
        markdown: 'one\ntwo\nthree',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        readonlyDocumentMode: false,
        onReady: (value) => (handle = value),
      },
    });

    handle?.setSelection(4, 7);
    expect(handle?.getSelectedMarkdown()).toBe('two');
    expect(handle?.lineAtOffset(5)).toBe(2);
    expect(handle?.offsetAtLine(3)).toBe(8);
  });

  it('does not duplicate Markdown changes across composition lifecycle events', () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const onMarkdownChange = vi.fn();
    const { container } = render(MarkdownSourceEditor, {
      props: {
        markdown: '',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        readonlyDocumentMode: false,
        onMarkdownChange,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    view.dispatch({ changes: { from: 0, insert: '中' } });
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }));

    expect(handle?.getMarkdown()).toBe('中');
    expect(onMarkdownChange).toHaveBeenCalledTimes(1);
  });

  it('keeps mode-switch history but resets it when the active document changes', async () => {
    let handle: MarkdownSourceEditorHandle | undefined;
    const rendered = render(MarkdownSourceEditor, {
      props: {
        markdown: 'first',
        documentId: 'tab-1',
        sourceEditor: undefined as unknown as MarkdownSourceEditorHandle,
        onReady: (value) => (handle = value),
      },
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector('.cm-editor')!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' edit' } });
    expect(handle?.undo()).toBe(true);
    expect(handle?.redo()).toBe(true);

    await rendered.rerender({
      markdown: 'second',
      documentId: 'tab-2',
      sourceEditor: handle as MarkdownSourceEditorHandle,
      onReady: (value) => (handle = value),
    });

    expect(handle?.getMarkdown()).toBe('second');
    expect(handle?.undo()).toBe(false);
  });
});
