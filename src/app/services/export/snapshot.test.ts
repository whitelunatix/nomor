import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureExportAppearance, captureExportSnapshot } from './snapshot';
import { createExportHtmlDocument } from '../exportService';

afterEach(() => { document.documentElement.removeAttribute('style'); document.documentElement.removeAttribute('data-theme'); vi.useRealTimers(); });

describe('HTML/PDF export snapshot', () => {
  it('等待提交期间切换标签和主题，内容、路径及样式仍属于原任务', async () => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    root.style.setProperty('--md-editor-font-document', 'serif');
    root.style.setProperty('--md-editor-font-size', '19px');
    let finish!: () => void;
    let markdown = 'old';
    const tab = { id: 'a', fileName: 'a.md', nativePath: 'D:/a.md' };
    const appearance = captureExportAppearance();
    const runtime = { disposed: false, editor: {
      awaitCompositionEnd: () => new Promise<void>(resolve => { finish = resolve; }),
      getSnapshot: () => ({ markdown, version: 5, contentRevision: 3 }),
    } };
    const pending = captureExportSnapshot(tab, runtime, { appearance, isAvailable: () => true, flush: () => { markdown = 'committed 中文'; } });
    tab.fileName = 'renamed.md';
    root.dataset.theme = 'light';
    root.style.setProperty('--md-editor-font-document', 'sans-serif');
    finish();
    const snapshot = (await pending)!;
    markdown = 'later edit';
    runtime.disposed = true;
    expect(snapshot).toMatchObject({ documentId: 'a', documentPath: 'D:/a.md', title: 'a.md', contentRevision: 3, markdown: 'committed 中文' });
    const html = createExportHtmlDocument('<p>正文</p>', snapshot.title, '', snapshot.appearance);
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('--md-editor-font-document: serif');
    expect(html).toContain('--md-editor-font-size: 19px');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('源码组字未结束时不读取快照；结束后提交一次', async () => {
    vi.useFakeTimers();
    let composing = true;
    const runtime = { disposed: false, sourceEditor: { isComposing: () => composing }, editor: {
      getSnapshot: vi.fn(() => ({ markdown: '源码中文', version: 2 })),
    } };
    const flush = vi.fn();
    const pending = captureExportSnapshot({ id: 'a', fileName: 'a.md', nativePath: null }, runtime, {
      appearance: captureExportAppearance(), isAvailable: () => true, flush,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(runtime.editor.getSnapshot).not.toHaveBeenCalled();
    composing = false;
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending)?.markdown).toBe('源码中文');
    expect(flush).toHaveBeenCalledOnce();
  });

  it('快照前关闭文档或取消任务不读取另一个编辑器', async () => {
    const runtime = { disposed: true, editor: { getSnapshot: vi.fn(() => ({ markdown: 'closed', version: 1 })) } };
    const args = { appearance: captureExportAppearance(), isAvailable: () => false, flush: vi.fn() };
    expect(await captureExportSnapshot({ id: 'a', fileName: 'a', nativePath: null }, runtime, args)).toBeNull();
    expect(runtime.editor.getSnapshot).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    await expect(captureExportSnapshot({ id: 'a', fileName: 'a', nativePath: null }, runtime, { ...args, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
