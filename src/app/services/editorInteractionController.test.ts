import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorCore, EditorMode } from '../../lib/editor-core';
import type { OutlineItem } from '../../lib/outline/outlineService';
import type { MarkdownSourceEditorHandle } from '../components/markdownSourceEditor';
import { createEditorInteractionController } from './editorInteractionController';

describe('editorInteractionController viewport layout', () => {
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;

  beforeEach(() => {
    originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof window.requestAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    vi.restoreAllMocks();
  });

  it('clamps source and semantic panes when the editor content height shrinks', () => {
    const sourcePane = createPane({ scrollHeight: 620, clientHeight: 420, scrollTop: 360 });
    const semanticPane = createPane({ scrollHeight: 540, clientHeight: 400, scrollTop: 260 });
    const sourceTextarea = createTextarea({ scrollHeight: 380, clientHeight: 240 });
    const controller = createController({
      mode: 'semantic',
      sourcePane,
      semanticPane,
      sourceTextarea,
    });

    controller.refreshEditorViewportLayout();

    // 文本域高度由源码编辑器自己维护；控制器只负责把两个面板的滚动位置夹回合法区间。
    expect(sourcePane.scrollTop).toBe(200);
    expect(semanticPane.scrollTop).toBe(140);
  });

  it('clamps restored source scroll after recalculating the textarea height', () => {
    const sourcePane = createPane({ scrollHeight: 480, clientHeight: 300, scrollTop: 20 });
    const semanticPane = createPane({ scrollHeight: 900, clientHeight: 300, scrollTop: 120 });
    const sourceTextarea = createTextarea({ scrollHeight: 520, clientHeight: 260 });
    const pendingSourceScrollTop = { value: 900 };
    const controller = createController({
      mode: 'source',
      sourcePane,
      semanticPane,
      sourceTextarea,
      pendingSourceScrollTop,
    });

    controller.syncSourceTextareaHeight(pendingSourceScrollTop.value);

    // 恢复位置 900 超过面板可滚动范围（480 - 300），必须夹到 180。
    expect(sourcePane.scrollTop).toBe(180);
    expect(pendingSourceScrollTop.value).toBeNull();
  });

  it('safely refreshes when editor panes are not bound yet', () => {
    const controller = createController({
      mode: 'semantic',
      sourcePane: undefined,
      semanticPane: undefined,
      sourceTextarea: undefined,
    });

    expect(() => controller.refreshEditorViewportLayout()).not.toThrow();
  });

  it('inserts the standard details template around source selection and focuses its title', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'before\n\nselected body\n\nafter';
    textarea.setSelectionRange(8, 21);
    const editor = createEditorCoreStub();
    editor.getMarkdown = () => textarea.value;
    const controller = createController({ mode: 'source', editor, sourcePane: undefined,
      semanticPane: undefined, sourceTextarea: textarea });
    controller.runCommand({ type: 'insertDetails' });
    expect(textarea.value).toBe('before\n\n<details>\n<summary></summary>\n\nselected body\n\n</details>\n\nafter');
    expect(textarea.selectionStart).toBe(textarea.value.indexOf('</summary>'));
    expect(editor.execute).not.toHaveBeenCalled();
  });

  it('scrolls the source pane to keep the caret visible after inserting a newline', () => {
    const sourcePane = createPane({ scrollHeight: 560, clientHeight: 100, scrollTop: 300 });
    sourcePane.getClientRects = () => [createRect(0)] as unknown as DOMRectList;
    const semanticPane = createPane({ scrollHeight: 400, clientHeight: 200, scrollTop: 0 });
    const sourceTextarea = createTextarea({ scrollHeight: 480, clientHeight: 100, lineCount: 20 });
    sourcePane.append(sourceTextarea);
    sourceTextarea.value = `${sourceTextarea.value}\nline 21`;
    sourceTextarea.setSelectionRange(sourceTextarea.value.length, sourceTextarea.value.length);
    const editor = createEditorCoreStub();
    const controller = createController({
      mode: 'source',
      editor,
      sourcePane,
      semanticPane,
      sourceTextarea,
      sourceLineHeight: 20,
    });
    controller.updateMarkdown(sourceTextarea.value);

    // 源码输入不再同步阻塞按键；滚动测量仍立即执行，正文同步延后到本拍之后。
    expect(editor.setMarkdown).not.toHaveBeenCalled();
    expect(sourcePane.scrollTop).toBeGreaterThan(300);

    controller.flushPendingMarkdown();
    expect(editor.setMarkdown).toHaveBeenCalledWith(sourceTextarea.value, {
      reason: 'source-input',
      sourceInput: true,
    });
  });

  it('coalesces rapid source input into one markdown sync with the latest text', () => {
    vi.useFakeTimers();
    try {
      const editor = createEditorCoreStub();
      const controller = createController({
        mode: 'source',
        editor,
        sourcePane: undefined,
        semanticPane: undefined,
        sourceTextarea: undefined,
      });

      controller.updateMarkdown('一');
      controller.updateMarkdown('一二');
      controller.updateMarkdown('一二三');
      expect(editor.setMarkdown).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      expect(editor.setMarkdown).toHaveBeenCalledTimes(1);
      expect(editor.setMarkdown).toHaveBeenCalledWith('一二三', {
        reason: 'source-input',
        sourceInput: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores semantic scroll after switching mode and waiting for layout frames', async () => {
    const callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof window.requestAnimationFrame;
    const mode = { value: 'source' as EditorMode };
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(300);
    const editor = createEditorCoreStub((nextMode) => {
      mode.value = nextMode;
    });
    const sourcePane = createPane({
      className: 'source-pane',
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 500,
    });
    const semanticPane = createSemanticPane(
      [
        { tag: 'h1', title: '第一章', top: 40 },
        { tag: 'h2', title: '第二章', top: 440 },
      ],
      1000,
      300,
    );
    const sourceTextarea = createTextarea({ scrollHeight: 1600, clientHeight: 300, lineCount: 80 });
    sourcePane.append(sourceTextarea);
    const controller = createController({
      mode,
      editor,
      outline: createOutline(),
      sourcePane,
      semanticPane,
      sourceTextarea,
      sourceLineHeight: 20,
    });

    await controller.setMode('semantic');

    expect(editor.updateOptions).toHaveBeenCalledWith({ mode: 'semantic' });
    // 切换后要等布局帧，滚动恢复不能同步发生。
    expect(semanticPane.scrollTop).toBe(0);

    await flushAnimationFramesUntilIdle(callbacks);
    expect(semanticPane.scrollTop).toBe(258);
  });

  it('keeps restored source scroll after the post-switch viewport refresh', async () => {
    const mode = { value: 'semantic' as EditorMode };
    const editor = createEditorCoreStub((nextMode) => {
      mode.value = nextMode;
    });
    const sourcePane = createPane({
      className: 'source-pane',
      scrollHeight: 1600,
      clientHeight: 400,
      scrollTop: 0,
    });
    const sourceTextarea = createTextarea({ scrollHeight: 1600, clientHeight: 300, lineCount: 80 });
    sourcePane.append(sourceTextarea);
    const semanticPane = createSemanticPane(
      [
        { tag: 'h1', title: '第一章', top: 40 },
        { tag: 'h2', title: '第二章', top: 440 },
      ],
      1000,
      300,
    );
    semanticPane.scrollTop = 250;
    const controller = createController({
      mode,
      editor,
      outline: createOutline(),
      sourcePane,
      semanticPane,
      sourceTextarea,
      sourceLineHeight: 20,
    });

    await controller.setMode('source');

    expect(editor.updateOptions).toHaveBeenCalledWith({ mode: 'source' });
    // 语义面板顶部可见的是「第二章」（第 41 行），切到源码模式应把该行顶到面板顶部：
    // getLineTop(41) = (41 - 1) * 20 = 800。
    expect(sourcePane.scrollTop).toBe(800);

    controller.refreshEditorViewportLayout();

    // 随后的布局刷新不能把刚恢复的阅读位置重置回 0。
    expect(sourcePane.scrollTop).toBe(800);
  });

  it('restores semantic scroll after round-trip through source mode', async () => {
    // 模拟真实浏览器行为：display:none 的面板 getBoundingClientRect().height 为 0，
    // 且 scrollTop 会被浏览器重置为 0。
    const callbacks: FrameRequestCallback[] = [];
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof window.requestAnimationFrame;
    const mode = { value: 'semantic' as EditorMode };
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(300);
    const sourcePane = createPane({
      className: 'source-pane',
      scrollHeight: 1200,
      clientHeight: 400,
      scrollTop: 0,
    });
    const sourceTextarea = createTextarea({ scrollHeight: 1600, clientHeight: 300, lineCount: 80 });
    sourcePane.append(sourceTextarea);
    const semanticScrollHeight = 1000;
    const semanticClientHeight = 300;
    let semanticHidden = false;
    const editor = createEditorCoreStub((nextMode) => {
      mode.value = nextMode;
      semanticHidden = nextMode === 'source';
    });
    const semanticPane = createPane({
      scrollHeight: semanticScrollHeight,
      clientHeight: semanticClientHeight,
      scrollTop: 250,
    });
    semanticPane.className = 'semantic-pane';
    semanticPane.getBoundingClientRect = () => createRect(semanticHidden ? 0 : 40);
    Object.defineProperty(semanticPane, 'getBoundingClientRect', {
      value: () => ({
        ...createRect(semanticHidden ? 0 : 40),
        height: semanticHidden ? 0 : semanticClientHeight,
      }),
    });
    // 模拟 display:hidden 的行为：scrollTop 被浏览器重置
    Object.defineProperty(semanticPane, 'scrollTop', {
      get() {
        return semanticHidden ? 0 : Number(semanticPane.dataset.scrollTop ?? 0);
      },
      set(v: number) {
        semanticPane.dataset.scrollTop = String(v);
      },
      configurable: true,
    });
    semanticPane.scrollTop = 250;

    const editor2 = document.createElement('div');
    editor2.className = 'ProseMirror';
    const h1 = document.createElement('h1');
    h1.textContent = '第一章';
    h1.getBoundingClientRect = () => createRect(40 - (semanticHidden ? 0 : semanticPane.scrollTop));
    const h2 = document.createElement('h2');
    h2.textContent = '第二章';
    h2.getBoundingClientRect = () =>
      createRect(440 - (semanticHidden ? 0 : semanticPane.scrollTop));
    editor2.append(h1, h2);
    semanticPane.append(editor2);

    const controller = createController({
      mode,
      editor,
      outline: createOutline(),
      sourcePane,
      semanticPane,
      sourceTextarea,
      sourceLineHeight: 20,
    });

    // 步骤1：从语义模式切换到源码模式（语义面板被隐藏）
    await controller.setMode('source');
    await flushAnimationFramesUntilIdle(callbacks);
    expect(sourcePane.scrollTop).toBeGreaterThan(0);

    // 步骤2：从源码模式切回语义模式（语义面板恢复显示）
    await controller.setMode('semantic');

    // 刷新所有动画帧，触发最终的滚动恢复
    await flushAnimationFramesUntilIdle(callbacks);

    // 应该恢复到接近原始位置（250），而不是 0
    expect(semanticPane.scrollTop).toBeGreaterThan(0);
  });
});

function createController(options: {
  mode: EditorMode | { value: EditorMode };
  sourcePane: HTMLElement | undefined;
  semanticPane: HTMLElement | undefined;
  sourceTextarea: HTMLTextAreaElement | undefined;
  pendingSourceScrollTop?: { value: number | null };
  editor?: EditorCore;
  outline?: OutlineItem[];
  sourceLineHeight?: number;
}) {
  const pendingSourceScrollTop = options.pendingSourceScrollTop ?? { value: null };
  return createEditorInteractionController({
    getEditor: () => options.editor ?? createEditorCoreStub(),
    getLargeDocumentMode: () => false,
    getMode: () => (typeof options.mode === 'string' ? options.mode : options.mode.value),
    getOutline: () => options.outline ?? [],
    getSemanticPane: () => options.semanticPane,
    getSourcePane: () => options.sourcePane,
    getSourceEditor: () => createSourceEditorStub(options.sourceTextarea),
    getPendingSourceScrollTop: () => pendingSourceScrollTop.value,
    setPendingSourceScrollTop: (value) => {
      pendingSourceScrollTop.value = value;
    },
    setSuppressOutlineScrollUntil: vi.fn(),
    setStatusMessage: vi.fn(),
    getSourceLineHeight: () => options.sourceLineHeight ?? 24,
  });
}

function createSourceEditorStub(
  textarea: HTMLTextAreaElement | undefined,
): MarkdownSourceEditorHandle | undefined {
  if (!textarea) return undefined;
  return {
    getMarkdown: () => textarea.value,
    placeCaretAtCoordinates: () => false,
    setMarkdown: (value) => {
      textarea.value = value;
    },
    getSelection: () => ({ from: textarea.selectionStart, to: textarea.selectionEnd }),
    replaceRange: (from, to, text) => { textarea.setRangeText(text, from, to, 'end'); return true; },
    setSelection: (from, to = from) => textarea.setSelectionRange(from, to),
    getSelectedMarkdown: () => textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
    focus: () => textarea.focus(),
    revealRange: (from, to = from) => textarea.setSelectionRange(from, to),
    undo: () => false,
    redo: () => false,
    lineAtOffset: (offset) => textarea.value.slice(0, offset).split(/\r?\n/).length,
    offsetAtLine: (line) =>
      textarea.value.split(/\r?\n/).slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0),
    getLineCount: () => textarea.value.split(/\r?\n/).length,
    getLineTop: (line) => (line - 1) * 20,
    lineAtHeight: (height) => Math.floor(height / 20) + 1,
    getLineHeight: () => 20,
    getScrollElement: () => textarea.parentElement ?? textarea,
    getContentElement: () => textarea,
    getContentHeight: () => textarea.scrollHeight,
    getBlockGeometry: () => [],
    applyBlockGaps: () => undefined,
    clearBlockGaps: () => undefined,
    requestMeasure: () => undefined,
  };
}

function createEditorCoreStub(onModeChange?: (mode: EditorMode) => void): EditorCore {
  return {
    updateOptions: vi.fn((options: { mode?: EditorMode }) => {
      if (options.mode) {
        onModeChange?.(options.mode);
      }
    }),
    setMarkdown: vi.fn(),
    getMarkdown: () => '',
    getSelectionAnchorRect: () => null,
    execute: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorCore;
}

function createPane(options: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  className?: string;
}) {
  const pane = document.createElement('section');
  if (options.className) {
    pane.className = options.className;
  }
  setElementMetric(pane, 'scrollHeight', options.scrollHeight);
  setElementMetric(pane, 'clientHeight', options.clientHeight);
  // jsdom 的 getClientRects() 恒为空；真实浏览器里可见面板一定有矩形。
  // 控制器用矩形数量判断面板是否已布局，这里补一个可见矩形让测量逻辑真正执行。
  pane.getClientRects = () => [createRect(0)] as unknown as DOMRectList;
  pane.scrollTop = options.scrollTop;
  return pane;
}

function createTextarea(options: {
  scrollHeight: number;
  clientHeight: number;
  lineCount?: number;
}) {
  const textarea = document.createElement('textarea');
  textarea.style.lineHeight = '20px';
  setElementMetric(textarea, 'scrollHeight', options.scrollHeight);
  setElementMetric(textarea, 'clientHeight', options.clientHeight);
  textarea.value = Array.from(
    { length: options.lineCount ?? 1 },
    (_, index) => `line ${index + 1}`,
  ).join('\n');
  return textarea;
}

function setElementMetric(
  element: HTMLElement,
  key: 'scrollHeight' | 'clientHeight',
  value: number,
) {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
  });
}

function createOutline(): OutlineItem[] {
  return [
    { id: '第一章', level: 1, title: '第一章', line: 1 },
    { id: '第二章', level: 2, title: '第二章', line: 41 },
  ];
}

function createSemanticPane(
  headings: Array<{ tag: 'h1' | 'h2'; title: string; top: number }>,
  scrollHeight: number,
  clientHeight: number,
) {
  const semanticPane = createPane({ scrollHeight, clientHeight, scrollTop: 0 });
  semanticPane.className = 'semantic-pane';
  // 面板矩形必须和真实布局一致（高度 = clientHeight），否则可见性判断会落空。
  semanticPane.getBoundingClientRect = () => ({
    ...createRect(0),
    bottom: clientHeight,
    height: clientHeight,
  });

  const editor = document.createElement('div');
  editor.className = 'ProseMirror';
  headings.forEach((heading) => {
    const element = document.createElement(heading.tag);
    element.textContent = heading.title;
    element.getBoundingClientRect = () => createRect(heading.top - semanticPane.scrollTop);
    editor.append(element);
  });
  semanticPane.append(editor);
  return semanticPane;
}

function createRect(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    bottom: top + 20,
    right: 100,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  };
}

function flushAnimationFrame(callbacks: FrameRequestCallback[]) {
  callbacks.shift()?.(0);
}

/**
 * 依次执行动画帧回调，并在每轮之后让出微任务：
 * 控制器里 `await waitForAnimationFrames()` 的续体会在微任务中注册下一帧，
 * 同步清空数组会漏掉这些后续回调。
 */
async function flushAnimationFramesUntilIdle(callbacks: FrameRequestCallback[]) {
  for (let turn = 0; turn < 40 && callbacks.length > 0; turn += 1) {
    while (callbacks.length > 0) flushAnimationFrame(callbacks);
    await Promise.resolve();
  }
}
