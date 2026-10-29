import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorCore } from '../../lib/editor-core';
import { extractOutline } from '../../lib/outline/outlineService';
import type { MarkdownSourceEditorHandle } from '../components/markdownSourceEditor';
import { createOutlineInteractionController } from './outlineInteractionController';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('outlineInteractionController', () => {
  it('restores collapsed and active identity after the deferred source analysis', async () => {
    vi.useFakeTimers();
    const markdown = '# Same\n## Child\n# Same\n';
    let outline = extractOutline(markdown);
    const textarea = document.createElement('textarea');
    textarea.value = markdown;
    const editor = createEditorCore({ markdown });
    const setMarkdown = vi.spyOn(editor, 'setMarkdown');
    let collapsed = new Set([outline[0].id]);
    let activeId = '';
    const setStatusMessage = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const sourceEditor = createSourceEditorStub(textarea, (value) => {
      editor.setMarkdown(textarea.value, { reason: 'source-input', sourceInput: true });
      outline = extractOutline(value);
    });
    const controller = createOutlineInteractionController({
      getMode: () => 'source',
      getMarkdown: () => markdown,
      getOutline: () => outline,
      getCollapsedOutlineIds: () => collapsed,
      setCollapsedOutlineIds: (value) => {
        collapsed = value;
      },
      getOutlineVisible: () => true,
      setOutlineVisible: vi.fn(),
      setActiveOutlineId: (value) => {
        activeId = value;
      },
      getSuppressOutlineScrollUntil: () => 0,
      setSuppressOutlineScrollUntil: vi.fn(),
      getSemanticPane: () => document.createElement('section'),
      getSourcePane: () => document.createElement('section'),
      getSourceEditor: () => sourceEditor,
      getEditor: () => editor,
      getReadonly: () => false,
      setStatusMessage,
    });

    expect(
      controller.moveOutlineSection({ sourceIndex: 0, targetIndex: 2, placement: 'after' }),
    ).toBe(true);
    expect(extractOutline(textarea.value).map((item) => item.title)).toEqual([
      'Same',
      'Same',
      'Child',
    ]);
    expect(activeId).toBe('');
    await vi.advanceTimersByTimeAsync(150);
    expect(activeId).toBe('same-2');
    expect(collapsed).toEqual(new Set(['same-2']));
    expect(setStatusMessage).toHaveBeenCalled();
    expect(setMarkdown).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  it('moves both panes when jumping from the outline in split mode', () => {
    const markdown = '# One\n\none\n\n# Two\n\ntwo';
    const outline = extractOutline(markdown);
    const semanticPane = document.createElement('section');
    semanticPane.className = 'semantic-pane';
    Object.defineProperty(semanticPane, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(semanticPane, 'clientHeight', { value: 400, configurable: true });
    semanticPane.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 600, width: 600, height: 400,
      toJSON: () => ({}),
    });
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const first = document.createElement('h1');
    first.textContent = 'One';
    first.id = 'one';
    first.getBoundingClientRect = () => ({
      x: 0, y: 80, top: 80, left: 0, bottom: 100, right: 600, width: 600, height: 20,
      toJSON: () => ({}),
    });
    const second = document.createElement('h1');
    second.textContent = 'Two';
    second.id = 'two';
    second.getBoundingClientRect = () => ({
      x: 0, y: 240, top: 240, left: 0, bottom: 260, right: 600, width: 600, height: 20,
      toJSON: () => ({}),
    });
    editor.append(first, second);
    semanticPane.append(editor);

    const textarea = document.createElement('textarea');
    textarea.value = markdown;
    const sourcePane = document.createElement('section');
    sourcePane.className = 'source-pane';
    Object.defineProperty(sourcePane, 'scrollHeight', { value: 800, configurable: true });
    Object.defineProperty(sourcePane, 'clientHeight', { value: 400, configurable: true });
    sourcePane.append(textarea);
    const sourceEditor = createSourceEditorStub(textarea);
    const editorCore = createEditorCore({ markdown });

    // 让滚动动画在第一帧就到达终点，便于断言最终位置。
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1000;
      return now;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const controller = createOutlineInteractionController({
      getMode: () => 'split',
      getMarkdown: () => markdown,
      getOutline: () => outline,
      getCollapsedOutlineIds: () => new Set(),
      setCollapsedOutlineIds: vi.fn(),
      getOutlineVisible: () => true,
      setOutlineVisible: vi.fn(),
      setActiveOutlineId: vi.fn(),
      getSuppressOutlineScrollUntil: () => 0,
      setSuppressOutlineScrollUntil: vi.fn(),
      getSemanticPane: () => semanticPane,
      getSourcePane: () => sourcePane,
      getSourceEditor: () => sourceEditor,
      getEditor: () => editorCore,
      getReadonly: () => false,
      setStatusMessage: vi.fn(),
    });

    controller.jumpToOutlineItem(outline[1]);

    // 两栏都要移动：只看源码栏会让语义视图停在原处。
    expect(semanticPane.scrollTop).toBe(208);
    expect(textarea.selectionStart).toBe(markdown.indexOf('# Two') + '# Two'.length);
    expect(sourcePane.scrollTop).toBeGreaterThan(0);

    editorCore.destroy();
  });

  it('flushes a semantic move immediately so document and outline update together', () => {
    let markdown = '# One\n\none\n\n# Two\n\ntwo';
    let outline = extractOutline(markdown);
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown, mode: 'semantic', target });
    editor.subscribe((event) => {
      if (event.reason !== 'content-sync') return;
      markdown = event.markdown;
      outline = extractOutline(markdown);
    });
    let activeId = '';
    const controller = createOutlineInteractionController({
      getMode: () => 'semantic',
      getMarkdown: () => markdown,
      getOutline: () => outline,
      getCollapsedOutlineIds: () => new Set(),
      setCollapsedOutlineIds: vi.fn(),
      getOutlineVisible: () => true,
      setOutlineVisible: vi.fn(),
      setActiveOutlineId: (value) => {
        activeId = value;
      },
      getSuppressOutlineScrollUntil: () => 0,
      setSuppressOutlineScrollUntil: vi.fn(),
      getSemanticPane: () => document.createElement('section'),
      getSourcePane: () => document.createElement('section'),
      getSourceEditor: () => createSourceEditorStub(document.createElement('textarea')),
      getEditor: () => editor,
      getReadonly: () => false,
      setStatusMessage: vi.fn(),
    });

    expect(
      controller.moveOutlineSection({ sourceIndex: 0, targetIndex: 1, placement: 'after' }),
    ).toBe(true);
    expect(outline.map((item) => item.title)).toEqual(['Two', 'One']);
    expect(activeId).toBe('one');
    expect([...target.querySelectorAll('h1')].map((heading) => heading.textContent)).toEqual([
      'Two',
      'One',
    ]);

    editor.destroy();
  });
});

function createSourceEditorStub(
  textarea: HTMLTextAreaElement,
  onChange: (value: string) => void = () => undefined,
): MarkdownSourceEditorHandle {
  return {
    getMarkdown: () => textarea.value,
    placeCaretAtCoordinates: () => false,
    setMarkdown: (value) => {
      textarea.value = value;
      onChange(value);
    },
    getSelection: () => ({ from: textarea.selectionStart, to: textarea.selectionEnd }),
    setSelection: (from, to = from) => textarea.setSelectionRange(from, to),
    getSelectedMarkdown: () => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
    focus: () => textarea.focus(),
    revealRange: (from, to = from) => textarea.setSelectionRange(from, to),
    undo: () => false,
    redo: () => false,
    lineAtOffset: (offset) => textarea.value.slice(0, offset).split(/\r?\n/).length,
    offsetAtLine: () => 0,
    getLineCount: () => textarea.value.split(/\r?\n/).length,
    getLineTop: (line) => (line - 1) * 20,
    lineAtHeight: (height) => Math.floor(height / 20) + 1,
    getLineHeight: () => 20,
    getScrollElement: () => textarea,
    getContentElement: () => textarea,
    getContentHeight: () => textarea.scrollHeight,
    getBlockGeometry: () => [],
    applyBlockGaps: () => undefined,
    clearBlockGaps: () => undefined,
    requestMeasure: () => undefined,
  };
}
