import { jsonSchema, tool, type ToolSet } from 'ai';
import { t } from '../../../app/i18n';
import type { EditorCore } from '../../editor-core/types';
import { extractOutline, type OutlineItem } from '../../outline/outlineService';
import { validateDocxMarkdown } from '../../docxmd/validate';
import { truncateText } from '../context';
import type { ApprovalBroker } from '../approval';
import { wrapUntrusted } from '../prompts';

/** 文档工具直接读写 EditorCore，不经过 IPC，工具调用不会打断打字。 */

export interface DocumentToolContext {
  getEditor(): EditorCore | null;
  isDocxMode(): boolean;
  approval: ApprovalBroker;
}

const MAX_READ_LINES = 400;
const DEFAULT_READ_LINES = 120;
const MAX_SEARCH_RESULTS = 30;

function requireEditor(context: DocumentToolContext): EditorCore {
  const editor = context.getEditor();
  if (!editor) {
    throw new Error(t.aiErrorNoDocument());
  }
  return editor;
}

function revisionOf(editor: EditorCore): number {
  return editor.getSnapshot().contentRevision ?? 0;
}

function splitLines(markdown: string): string[] {
  return markdown.split('\n');
}

function clampLine(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** 找到标题对应的区间：从该标题行到下一个同级或更高级标题之前。 */
function headingRange(
  outline: OutlineItem[],
  query: string,
): { fromLine: number; toLine: number; item: OutlineItem } | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const index = outline.findIndex((item) => item.title.toLowerCase().includes(normalized));
  if (index < 0) {
    return null;
  }
  const item = outline[index]!;
  const next = outline.slice(index + 1).find((candidate) => candidate.level <= item.level);
  return {
    fromLine: item.line,
    toLine: next ? next.line - 1 : Number.MAX_SAFE_INTEGER,
    item,
  };
}

function selectionText(editor: EditorCore): string {
  return editor.getClipboardPayload()?.text ?? '';
}

function describeEdit(fromLine: number, toLine: number, current: string, next: string): string {
  const head = t.aiApprovalEditTitle({ from: String(fromLine), to: String(toLine) });
  const before = truncateText(current || t.aiApprovalEditEmpty(), 1200);
  const after = truncateText(next || t.aiApprovalEditDelete(), 1200);
  return `${head}\n\n--- ${t.aiApprovalEditCurrent()} ---\n${before}\n\n+++ ${t.aiApprovalEditReplacement()} +++\n${after}`;
}

function createApprovalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDocumentTools(context: DocumentToolContext): ToolSet {
  const docOutline = tool({
    description: '列出当前文档的标题大纲（层级、行号）。需要了解文档结构或定位章节时先调用它。',
    inputSchema: jsonSchema<{ maxLevel?: number }>({
      type: 'object',
      properties: {
        maxLevel: {
          type: 'number',
          description: '只返回层级不高于该值的标题（1–6），省略表示全部',
        },
      },
      additionalProperties: false,
    }),
    execute: async ({ maxLevel }) => {
      const editor = requireEditor(context);
      const markdown = editor.getMarkdown();
      const outline = extractOutline(markdown);
      const limit = typeof maxLevel === 'number' ? maxLevel : 6;
      return {
        contentRevision: revisionOf(editor),
        totalLines: splitLines(markdown).length,
        items: outline
          .filter((item) => item.level <= limit)
          .slice(0, 400)
          .map((item) => ({ level: item.level, title: item.title, line: item.line })),
      };
    },
  });

  const docRead = tool({
    description:
      '按行号区间或标题读取正文片段。返回内容包含 contentRevision，修改文档时要原样带回。',
    inputSchema: jsonSchema<{
      fromLine?: number;
      toLine?: number;
      heading?: string;
      maxLines?: number;
    }>({
      type: 'object',
      properties: {
        fromLine: { type: 'number', description: '起始行号（1 基，含）' },
        toLine: { type: 'number', description: '结束行号（1 基，含）' },
        heading: { type: 'string', description: '按标题文本片段定位章节' },
        maxLines: { type: 'number', description: `最多返回多少行，默认 ${DEFAULT_READ_LINES}` },
      },
      additionalProperties: false,
    }),
    execute: async ({ fromLine, toLine, heading, maxLines }) => {
      const editor = requireEditor(context);
      const markdown = editor.getMarkdown();
      const lines = splitLines(markdown);
      const totalLines = lines.length;

      let start = 1;
      let end = Math.min(totalLines, DEFAULT_READ_LINES);
      let headingTitle: string | undefined;

      if (typeof heading === 'string' && heading.trim()) {
        const range = headingRange(extractOutline(markdown), heading);
        if (!range) {
          throw new Error(t.aiErrorHeadingMissing({ heading }));
        }
        start = range.fromLine;
        end = Math.min(range.toLine, totalLines);
        headingTitle = range.item.title;
      }
      if (typeof fromLine === 'number') {
        start = clampLine(fromLine, start, totalLines);
      }
      if (typeof toLine === 'number') {
        end = clampLine(toLine, totalLines, totalLines);
      }
      const limit = clampLine(maxLines, DEFAULT_READ_LINES, MAX_READ_LINES);
      end = Math.min(end, start + limit - 1, totalLines);

      const text = lines.slice(start - 1, end).join('\n');
      return {
        contentRevision: revisionOf(editor),
        totalLines,
        fromLine: start,
        toLine: end,
        heading: headingTitle,
        text: wrapUntrusted('document', truncateText(text, 12_000)),
      };
    },
  });

  const docSearch = tool({
    description: '在当前文档中检索文本，返回匹配行号与上下文。',
    inputSchema: jsonSchema<{ query: string; maxResults?: number; caseSensitive?: boolean }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的文本（按字面匹配，不支持正则）' },
        maxResults: {
          type: 'number',
          description: `最多返回条数，默认 10，上限 ${MAX_SEARCH_RESULTS}`,
        },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认否' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query, maxResults, caseSensitive }) => {
      const editor = requireEditor(context);
      const markdown = editor.getMarkdown();
      const lines = splitLines(markdown);
      const needle = caseSensitive ? query : query.toLowerCase();
      const limit = clampLine(maxResults ?? 10, 10, MAX_SEARCH_RESULTS);

      const matches: Array<{ line: number; text: string; context: string }> = [];
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index]!;
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(needle)) {
          continue;
        }
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        matches.push({
          line: index + 1,
          text: truncateText(line, 300),
          context: truncateText(lines.slice(from, to).join('\n'), 800),
        });
      }

      return {
        contentRevision: revisionOf(editor),
        totalLines: lines.length,
        matchCount: matches.length,
        truncated: matches.length >= limit,
        matches,
      };
    },
  });

  const docSelection = tool({
    description: '返回用户当前选中的 Markdown 文本。用户说「这段」「选中部分」时先调用它。',
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const editor = requireEditor(context);
      const text = selectionText(editor);
      return {
        contentRevision: revisionOf(editor),
        hasSelection: text.length > 0,
        text: text ? wrapUntrusted('selection', truncateText(text, 8_000)) : '',
      };
    },
  });

  const docDiagnostics = tool({
    description:
      '检查 .docx.md 指令的一致性（未定义变量、重复定义、缺失指令等），普通 Markdown 没有诊断信息。',
    inputSchema: jsonSchema<{ maxItems?: number }>({
      type: 'object',
      properties: {
        maxItems: { type: 'number', description: '最多返回多少条诊断，默认 50' },
      },
      additionalProperties: false,
    }),
    execute: async ({ maxItems }) => {
      const editor = requireEditor(context);
      const markdown = editor.getMarkdown();
      if (!context.isDocxMode()) {
        return { docxMode: false, summary: t.aiDocDiagnosticsNotDocx() };
      }
      const summary = validateDocxMarkdown(markdown);
      const limit = clampLine(maxItems ?? 50, 50, 200);
      return {
        docxMode: true,
        errorCount: summary.errorCount,
        warningCount: summary.warningCount,
        directiveCount: summary.directiveCount,
        truncated: summary.diagnostics.length > limit,
        diagnostics: summary.diagnostics.slice(0, limit).map((diagnostic) => ({
          line: diagnostic.sourceLine ?? 0,
          severity: diagnostic.severity,
          code: diagnostic.code,
          message: diagnostic.message,
        })),
      };
    },
  });

  const docApplyEdit = tool({
    description:
      '把文档的第 fromLine–toLine 行（1 基，含首尾）替换为新的 Markdown。写入前会请用户批准，写入后可用一次撤销还原。expectedContentRevision 必须来自最近一次读取工具的结果。',
    inputSchema: jsonSchema<{
      fromLine: number;
      toLine: number;
      markdown: string;
      expectedContentRevision: number;
    }>({
      type: 'object',
      properties: {
        fromLine: { type: 'number', description: '起始行号（1 基，含）' },
        toLine: { type: 'number', description: '结束行号（1 基，含）' },
        markdown: { type: 'string', description: '替换后的 Markdown；空字符串表示删除该区间' },
        expectedContentRevision: {
          type: 'number',
          description: '最近一次 doc_* 读取结果里的 contentRevision',
        },
      },
      required: ['fromLine', 'toLine', 'markdown', 'expectedContentRevision'],
      additionalProperties: false,
    }),
    execute: async (
      { fromLine, toLine, markdown, expectedContentRevision },
      { abortSignal, toolCallId },
    ) => {
      const editor = requireEditor(context);
      const current = editor.getMarkdown();
      const lines = splitLines(current);
      const total = lines.length;
      const start = clampLine(fromLine, 1, total);
      const end = clampLine(toLine, start, total);
      if (start > end) {
        throw new Error(
          t.aiErrorLineRangeInvalid({ from: String(fromLine), to: String(toLine) }),
        );
      }

      const decision = await context.approval.request(
        {
          id: createApprovalId(),
          toolName: 'doc_apply_edit',
          toolCallId,
          title: t.aiApprovalEditTitle({ from: String(start), to: String(end) }),
          detail: describeEdit(start, end, lines.slice(start - 1, end).join('\n'), markdown),
          input: { fromLine: start, toLine: end, markdown },
        },
        abortSignal,
      );
      if (decision !== 'approve') {
        return { applied: false, denied: true, reason: t.aiDeniedEdit() };
      }

      const applied = editor.execute({
        type: 'applyMarkdownPatch',
        fromLine: start,
        toLine: end,
        markdown,
        expectedContentRevision,
      });
      if (!applied) {
        throw new Error(t.aiErrorEditConflict());
      }
      return { applied: true, fromLine: start, toLine: end };
    },
  });

  return {
    doc_outline: docOutline,
    doc_read: docRead,
    doc_search: docSearch,
    doc_selection: docSelection,
    doc_diagnostics: docDiagnostics,
    doc_apply_edit: docApplyEdit,
  };
}
