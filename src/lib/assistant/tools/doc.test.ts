import { afterEach, describe, expect, it } from 'vitest';
import type { ToolSet } from 'ai';
import { createEditorCore } from '../../editor-core/createEditorCore';
import type { EditorCore } from '../../editor-core/types';
import { ApprovalBroker, type ApprovalDecision } from '../approval';
import { createDocumentTools, type DocumentToolContext } from './doc';

const mounted: Array<{ editor: EditorCore; target: HTMLElement }> = [];

function mount(markdown: string, docxMode = false): EditorCore {
  const target = document.createElement('div');
  document.body.append(target);
  const editor = createEditorCore({ markdown, target, docxMode });
  mounted.push({ editor, target });
  return editor;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    entry.editor.destroy();
    entry.target.remove();
  }
  document.body.innerHTML = '';
});

interface ExecutableTool {
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

/** 直接调用工具的 execute，跳过 AI SDK 的模型调用。 */
async function runTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const definition = tools[name] as unknown as ExecutableTool;
  if (!definition?.execute) {
    throw new Error(`工具 ${name} 没有 execute`);
  }
  const output = await definition.execute(input, {
    toolCallId: 'test-call',
    messages: [],
    abortSignal: signal,
  });
  return output as Record<string, any>;
}

/** 收到审批请求就立刻按指定决定处理。 */
function autoDecide(broker: ApprovalBroker, decision: ApprovalDecision): () => void {
  return broker.subscribe((current) => {
    if (current) {
      broker.resolve(current.id, decision);
    }
  });
}

function contextFor(
  editor: EditorCore | null,
  options: { docxMode?: boolean; approval?: ApprovalBroker } = {},
): DocumentToolContext {
  return {
    getEditor: () => editor,
    isDocxMode: () => options.docxMode ?? false,
    approval: options.approval ?? new ApprovalBroker(),
  };
}

const MARKDOWN = '# 标题\n\n第一段内容\n\n## 小节\n\n第二段内容';

describe('doc_outline', () => {
  it('返回标题层级、行号与内容版本', () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));

    return runTool(tools, 'doc_outline', {}).then((result) => {
      expect(result.contentRevision).toBe(editor.getSnapshot().contentRevision ?? 0);
      expect(result.totalLines).toBe(7);
      expect(result.items).toEqual([
        { level: 1, title: '标题', line: 1 },
        { level: 2, title: '小节', line: 5 },
      ]);
    });
  });

  it('maxLevel 过滤深层标题', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_outline', { maxLevel: 1 });
    expect(result.items).toHaveLength(1);
  });
});

describe('doc_read', () => {
  it('默认从第一行开始读取，并把正文包成不可信内容', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_read', {});

    expect(result.fromLine).toBe(1);
    expect(result.toLine).toBe(7);
    expect(result.text).toContain('<untrusted source="document">');
    expect(result.text).toContain('第二段内容');
  });

  it('按标题读取到下一个同级标题之前', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_read', { heading: '小节' });

    expect(result.heading).toBe('小节');
    expect(result.fromLine).toBe(5);
    expect(result.toLine).toBe(7);
    expect(result.text).toContain('第二段内容');
    expect(result.text).not.toContain('第一段内容');
  });

  it('标题不存在时抛错', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    await expect(runTool(tools, 'doc_read', { heading: '不存在' })).rejects.toThrow('No section heading contains');
  });

  it('行号越界时收敛到有效范围', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_read', { fromLine: 6, toLine: 999 });
    expect(result.fromLine).toBe(6);
    expect(result.toLine).toBe(7);
  });
});

describe('doc_search', () => {
  it('返回匹配行号与上下文，默认忽略大小写', async () => {
    const editor = mount('# Title\n\nhello world\n\nHELLO again');
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_search', { query: 'hello' });

    expect(result.matchCount).toBe(2);
    expect(result.matches.map((match: { line: number }) => match.line)).toEqual([3, 5]);
    expect(result.matches[0].context).toContain('hello world');
  });

  it('区分大小写时只命中精确形式', async () => {
    const editor = mount('# Title\n\nhello world\n\nHELLO again');
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_search', { query: 'HELLO', caseSensitive: true });
    expect(result.matchCount).toBe(1);
    expect(result.matches[0].line).toBe(5);
  });

  it('maxResults 限制条数并标记截断', async () => {
    const editor = mount('a\na\na\na');
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_search', { query: 'a', maxResults: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('doc_selection', () => {
  it('没有选区时 hasSelection 为 false', async () => {
    const editor = mount(MARKDOWN);
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_selection', {});
    expect(result.hasSelection).toBe(false);
    expect(result.text).toBe('');
  });

  it('全选后返回选中文本', async () => {
    const editor = mount(MARKDOWN);
    editor.selectAll();
    const tools = createDocumentTools(contextFor(editor));
    const result = await runTool(tools, 'doc_selection', {});
    expect(result.hasSelection).toBe(true);
    expect(result.text).toContain('第一段内容');
  });
});

describe('doc_diagnostics', () => {
  it('非 docx 文档直接说明无需检查', async () => {
    const editor = mount(MARKDOWN, false);
    const tools = createDocumentTools(contextFor(editor, { docxMode: false }));
    const result = await runTool(tools, 'doc_diagnostics', {});
    expect(result.docxMode).toBe(false);
  });

  it('docx 文档返回诊断汇总', async () => {
    const markdown = '# 标题\n\ndocx_page_setup size="A4"\n\n正文';
    const editor = mount(markdown, true);
    const tools = createDocumentTools(contextFor(editor, { docxMode: true }));
    const result = await runTool(tools, 'doc_diagnostics', {});
    expect(result.docxMode).toBe(true);
    expect(typeof result.errorCount).toBe('number');
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });
});

describe('doc_apply_edit', () => {
  it('批准后替换区间，且一次撤销即可还原', async () => {
    const editor = mount(MARKDOWN);
    const broker = new ApprovalBroker();
    const unsubscribe = autoDecide(broker, 'approve');
    const tools = createDocumentTools(contextFor(editor, { approval: broker }));

    const result = await runTool(tools, 'doc_apply_edit', {
      fromLine: 3,
      toLine: 3,
      markdown: '第一段（改）',
      expectedContentRevision: editor.getSnapshot().contentRevision ?? 0,
    });
    unsubscribe();

    expect(result.applied).toBe(true);
    expect(editor.getMarkdown()).toContain('第一段（改）');

    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(editor.getMarkdown()).toContain('第一段内容');
  });

  it('拒绝时不改动文档', async () => {
    const editor = mount(MARKDOWN);
    const broker = new ApprovalBroker();
    const unsubscribe = autoDecide(broker, 'deny');
    const tools = createDocumentTools(contextFor(editor, { approval: broker }));

    const result = await runTool(tools, 'doc_apply_edit', {
      fromLine: 3,
      toLine: 3,
      markdown: '不该出现',
      expectedContentRevision: editor.getSnapshot().contentRevision ?? 0,
    });
    unsubscribe();

    expect(result).toMatchObject({ applied: false, denied: true });
    expect(editor.getMarkdown()).not.toContain('不该出现');
  });

  it('内容版本过期时抛错，提示重新读取', async () => {
    const editor = mount(MARKDOWN);
    const broker = new ApprovalBroker();
    const unsubscribe = autoDecide(broker, 'approve');
    const tools = createDocumentTools(contextFor(editor, { approval: broker }));

    const stale = editor.getSnapshot().contentRevision ?? 0;
    editor.execute({ type: 'insertText', text: 'X' });

    await expect(
      runTool(tools, 'doc_apply_edit', {
        fromLine: 3,
        toLine: 3,
        markdown: '覆盖',
        expectedContentRevision: stale,
      }),
    ).rejects.toThrow('document changed');
    unsubscribe();
  });

  it('审批被中止时按拒绝处理', async () => {
    const editor = mount(MARKDOWN);
    const broker = new ApprovalBroker();
    const tools = createDocumentTools(contextFor(editor, { approval: broker }));

    const controller = new AbortController();
    const pending = runTool(
      tools,
      'doc_apply_edit',
      { fromLine: 3, toLine: 3, markdown: 'x', expectedContentRevision: 0 },
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({ applied: false });
  });
});

describe('没有打开的文档', () => {
  it('任何文档工具都给出明确错误', async () => {
    const tools = createDocumentTools(contextFor(null));
    await expect(runTool(tools, 'doc_outline', {})).rejects.toThrow('No document is open');
  });
});
