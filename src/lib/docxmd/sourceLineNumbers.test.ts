import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
  buildEffectiveLineNumbers,
  shouldShowSourceLineNumber,
  sourceLineNumbers,
} from './sourceLineNumbers';

function createView(doc: string, docxMode: boolean): { host: HTMLElement; view: EditorView } {
  const host = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [sourceLineNumbers(docxMode)] }),
    parent: host,
  });
  return { host, view };
}

function renderedNumbers(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>('.cm-source-line-numbers .cm-gutterElement'))
    .map((element) => element.textContent ?? '')
    .filter((text) => text.length > 0);
}

describe('shouldShowSourceLineNumber', () => {
  it('numbers lines that carry content', () => {
    expect(shouldShowSourceLineNumber('# 第一章', true)).toBe(true);
    expect(shouldShowSourceLineNumber('普通正文', true)).toBe(true);
    expect(shouldShowSourceLineNumber('- 列表项', false)).toBe(true);
  });

  it('skips empty and whitespace-only lines', () => {
    expect(shouldShowSourceLineNumber('', true)).toBe(false);
    expect(shouldShowSourceLineNumber('   ', true)).toBe(false);
    expect(shouldShowSourceLineNumber('\t', false)).toBe(false);
  });

  it('skips docx directive lines so only real content is numbered', () => {
    expect(shouldShowSourceLineNumber('<!-- font | bold -->', true)).toBe(false);
    expect(shouldShowSourceLineNumber('  <!-- @page | a4 -->  ', true)).toBe(false);
    // 未闭合但看起来像指令的行同样不编号。
    expect(shouldShowSourceLineNumber('<!-- font | bold', true)).toBe(false);
  });

  it('numbers everything with content outside docx mode', () => {
    expect(shouldShowSourceLineNumber('<!-- font | bold -->', false)).toBe(true);
  });

  it('still numbers ordinary comments that are not directives', () => {
    expect(shouldShowSourceLineNumber('<!-- 普通注释 -->', true)).toBe(true);
    expect(shouldShowSourceLineNumber('<!-- @page | a4 -->', true)).toBe(false);
  });
});

describe('buildEffectiveLineNumbers', () => {
  it('counts only lines with content and skips directives in docx mode', () => {
    const lines = ['标题', '', '<!-- use body -->', '正文', '   ', '下一段'];

    expect(buildEffectiveLineNumbers(lines, true)).toEqual([0, 1, 1, 1, 2, 2, 3]);
    // 非 docx 模式下指令行也是普通内容，照样占号。
    expect(buildEffectiveLineNumbers(lines, false)).toEqual([0, 1, 1, 2, 3, 3, 4]);
  });
});

describe('sourceLineNumbers gutter', () => {
  it('renders numbers in a dedicated left gutter instead of inside the text flow', () => {
    const { host, view } = createView('# 第一章\n\n正文', true);

    expect(host.querySelector('.cm-source-line-numbers')).not.toBeNull();
    // 数字是 gutter 元素，不在 .cm-line 里。
    expect(host.querySelector('.cm-line .source-line-number')).toBeNull();
    // 空行不占号：正文是第 2 条有效行，不是物理第 3 行。
    expect(renderedNumbers(host)).toEqual(['1', '2']);

    view.destroy();
    host.remove();
  });

  it('hides blank and directive lines and keeps the numbering dense', () => {
    const { host, view } = createView('正文\n\n<!-- font | bold -->\n下一段', true);

    expect(renderedNumbers(host)).toEqual(['1', '2']);

    view.destroy();
    host.remove();
  });

  it('numbers directive lines outside docx mode', () => {
    const { host, view } = createView('正文\n\n<!-- font | bold -->', false);

    expect(renderedNumbers(host)).toEqual(['1', '2']);

    view.destroy();
    host.remove();
  });

  it('updates numbers when a line turns into a directive', () => {
    const { host, view } = createView('正文\n普通段落', true);
    expect(renderedNumbers(host)).toEqual(['1', '2']);

    view.dispatch({ changes: { from: 3, to: 7, insert: '<!-- font | bold -->' } });

    expect(renderedNumbers(host)).toEqual(['1']);

    view.destroy();
    host.remove();
  });
});
