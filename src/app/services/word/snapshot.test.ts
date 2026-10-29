import { describe, expect, it, vi } from 'vitest';
import { captureWordSnapshot } from './snapshot';

describe('Word snapshot', () => {
  it('等待编辑提交期间切换活动标签，仍只导出原文档及路径', async () => {
    let finish!: () => void;
    let body = 'old';
    const original = { id: 'a', nativePath: 'D:/a.md', fileName: 'a.md' };
    let active = original;
    const runtime = { disposed: false, editor: {
      awaitCompositionEnd: () => new Promise<void>((resolve) => { finish = resolve; }),
      getMarkdown: () => body,
    } };
    const flush = vi.fn((id) => { expect(id).toBe('a'); body = 'committed 中文'; });
    const result = captureWordSnapshot(original, runtime, { signal: new AbortController().signal, isAvailable: () => true, flush });
    active = { id: 'b', nativePath: 'D:/b.md', fileName: 'b.md' };
    finish();
    const snapshot = await result;
    expect(active.id).toBe('b');
    expect(snapshot).toMatchObject({ markdown: 'committed 中文', documentPath: 'D:/a.md', suggestedFileName: 'a' });
    body = 'later edit';
    expect(snapshot?.markdown).toBe('committed 中文');
    expect(flush).toHaveBeenCalledOnce();
  });

  it('目标文档在等待期间关闭，不读取另一个文档', async () => {
    const runtime = { disposed: true, editor: { getMarkdown: vi.fn(() => 'closed') } };
    const flush = vi.fn();
    expect(await captureWordSnapshot({ id: 'a', nativePath: null, fileName: 'a' }, runtime, {
      signal: new AbortController().signal, isAvailable: () => false, flush,
    })).toBeNull();
    expect(flush).not.toHaveBeenCalled();
    expect(runtime.editor.getMarkdown).not.toHaveBeenCalled();
  });
});
