import { afterEach, describe, expect, it } from 'vitest';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';

const mounted: Array<{ editor: EditorCore; target: HTMLElement }> = [];

function mount(markdown: string, docxMode = false): EditorCore {
  const target = document.createElement('div');
  document.body.append(target);
  const editor = createEditorCore({ markdown, target, docxMode });
  mounted.push({ editor, target });
  return editor;
}

function revisionOf(editor: EditorCore): number {
  return editor.getSnapshot().contentRevision ?? 0;
}

/** 序列化结果不带结尾空行，比较时统一去掉行尾空白。 */
function text(editor: EditorCore): string {
  return editor.getMarkdown().replace(/\s+$/, '');
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    entry.editor.destroy();
    entry.target.remove();
  }
  document.body.innerHTML = '';
});

describe('applyMarkdownPatch', () => {
  const markdown = '# 标题\n\n第一段\n\n第二段\n';

  it('替换单个段落并可用一次撤销还原', () => {
    const editor = mount(markdown);
    const before = editor.getMarkdown();
    const ok = editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 3,
      toLine: 3,
      markdown: '第一段（改）',
      expectedContentRevision: revisionOf(editor),
    });
    expect(ok).toBe(true);
    expect(text(editor)).toBe('# 标题\n\n第一段（改）\n\n第二段');

    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(text(editor)).toBe(before.replace(/\s+$/, ''));
  });

  it('替换多行区间（整节）', () => {
    const editor = mount(markdown);
    const ok = editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 3,
      toLine: 5,
      markdown: '新的第一段\n\n新的第二段',
      expectedContentRevision: revisionOf(editor),
    });
    expect(ok).toBe(true);
    expect(text(editor)).toBe('# 标题\n\n新的第一段\n\n新的第二段');
  });

  it('空内容表示删除该区间', () => {
    const editor = mount(markdown);
    const ok = editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 3,
      toLine: 4,
      markdown: '',
      expectedContentRevision: revisionOf(editor),
    });
    expect(ok).toBe(true);
    expect(text(editor)).toBe('# 标题\n\n第二段');
  });

  it('内容未变化时不派发事务', () => {
    const editor = mount(markdown);
    const before = editor.getSnapshot();
    const ok = editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 3,
      toLine: 3,
      markdown: '第一段',
      expectedContentRevision: before.contentRevision ?? 0,
    });
    expect(ok).toBe(false);
    expect(editor.getSnapshot().version).toBe(before.version);
    expect(text(editor)).toBe(markdown.replace(/\s+$/, ''));
  });

  it('内容版本不一致时拒绝，避免覆盖用户新输入', () => {
    const editor = mount(markdown);
    const stale = revisionOf(editor);
    editor.execute({ type: 'insertText', text: 'X' });
    const ok = editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 3,
      toLine: 3,
      markdown: '被拒绝的修改',
      expectedContentRevision: stale,
    });
    expect(ok).toBe(false);
    expect(editor.getMarkdown()).not.toContain('被拒绝的修改');
  });

  it('只重写变化的顶层块，保留其余节点身份（撤销仍然可用）', () => {
    const editor = mount(markdown);
    const before = editor.getMarkdown();
    editor.execute({
      type: 'applyMarkdownPatch',
      fromLine: 5,
      toLine: 5,
      markdown: '第二段（改）',
      expectedContentRevision: revisionOf(editor),
    });
    expect(text(editor)).toBe('# 标题\n\n第一段\n\n第二段（改）');
    editor.execute({ type: 'undo' });
    expect(text(editor)).toBe(before.replace(/\s+$/, ''));
  });
});
