import { invoke } from '@tauri-apps/api/core';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { t } from '../../../app/i18n';
import type { ApprovalBroker } from '../approval';
import { formatToolOutput, TOOL_OUTPUT_LIMIT, truncateText } from '../context';
import { wrapUntrusted } from '../prompts';

/**
 * 文件工具：工作区固定为「当前文档所在目录」，由 Rust 侧再次校验。
 *
 * 读和列目录只读；写入默认关闭，开启后每次仍需用户批准。文件内容
 * 一律按不可信输入处理，避免被文件里的文字带偏。
 */

export interface FileToolContext {
  /** 每次调用都重新取：用户可能切换了标签页。 */
  getDocumentPath: () => string | null;
  approval: ApprovalBroker;
}

interface FileReadPayload {
  path: string;
  relativePath: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

interface FileListPayload {
  root: string;
  path: string;
  truncated: boolean;
  entries: Array<{
    name: string;
    relativePath: string;
    kind: 'file' | 'dir';
    size: number | null;
  }>;
}

interface FileWritePayload {
  relativePath: string;
  bytes: number;
  created: boolean;
  backupPath: string | null;
  sha256: string;
}

const MAX_READ_LIMIT = 1024 * 1024;
const MAX_WRITE_LIMIT = 2 * 1024 * 1024;
const MAX_INLINE_CHARS = 24_000;

function documentPath(context: FileToolContext): string {
  const path = context.getDocumentPath();
  if (!path) {
    throw new Error(t.aiErrorFileNoWorkspace());
  }
  return path;
}

function approvalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 只用于审批卡片预览；读不到（新文件/二进制）时返回 null。 */
async function previewExisting(
  document: string,
  path: string,
): Promise<string | null> {
  try {
    const result = await invoke<FileReadPayload>('assistant_file_read', {
      documentPath: document,
      path,
      maxBytes: 4096,
    });
    return result.content;
  } catch {
    return null;
  }
}

function describeWrite(
  path: string,
  current: string | null,
  next: string,
): string {
  const head = t.aiFileApprovalTitle({ path });
  const before = current === null ? t.aiFileApprovalNewFile() : truncateText(current, 1200);
  const after = truncateText(next || t.aiApprovalEditEmpty(), 1200);
  return `${head}\n\n--- ${t.aiApprovalEditCurrent()} ---\n${before}\n\n+++ ${t.aiApprovalEditReplacement()} +++\n${after}`;
}

export function createFileTools(context: FileToolContext): ToolSet {
  return {
    file_list: tool({
      description:
        '列出当前文档所在目录（工作区）下的文件与子目录。path 必须是相对路径，省略表示根目录；depth 最大 3。',
      inputSchema: jsonSchema<{ path?: string; depth?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的路径；省略表示根目录。' },
          depth: { type: 'number', description: '递归深度 1–3，默认 1。' },
        },
        additionalProperties: false,
      }),
      execute: async ({ path, depth }) => {
        const result = await invoke<FileListPayload>('assistant_file_list', {
          documentPath: documentPath(context),
          path: path ?? null,
          depth: typeof depth === 'number' ? Math.trunc(depth) : null,
        });
        return truncateText(
          formatToolOutput({
            root: result.root,
            path: result.path,
            truncated: result.truncated,
            entries: result.entries,
          }),
          TOOL_OUTPUT_LIMIT,
        );
      },
    }),

    file_read: tool({
      description:
        '读取工作区内某个文本文件的局部内容。路径必须是相对路径；单次最多 1MB，超出会截断。二进制文件会被拒绝。',
      inputSchema: jsonSchema<{ path: string; maxBytes?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径。' },
          maxBytes: {
            type: 'number',
            description: `最多读取的字节数，1–${MAX_READ_LIMIT}，默认 ${MAX_READ_LIMIT}。`,
          },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, maxBytes }) => {
        const limit =
          typeof maxBytes === 'number'
            ? Math.min(Math.max(Math.trunc(maxBytes), 1), MAX_READ_LIMIT)
            : null;
        const result = await invoke<FileReadPayload>('assistant_file_read', {
          documentPath: documentPath(context),
          path,
          maxBytes: limit,
        });
        const body = truncateText(result.content, MAX_INLINE_CHARS);
        const note = result.truncated ? '\n\n（文件超过读取上限，内容已截断）' : '';
        return `${wrapUntrusted(`file:${result.relativePath}`, body)}${note}`;
      },
    }),

    file_write: tool({
      description:
        '在工作区内创建或覆盖一个文本文件。路径必须是相对路径，不能写当前打开的文档；单次最多 2MB。写入前需要用户批准，旧内容会先备份。',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径。' },
          content: { type: 'string', description: '要写入的完整文本内容。' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
      execute: async ({ path, content }, { abortSignal, toolCallId }) => {
        if (content.length > MAX_WRITE_LIMIT) {
          throw new Error(t.aiErrorFileTooLarge());
        }
        const document = documentPath(context);
        const current = await previewExisting(document, path);
        const decision = await context.approval.request(
          {
            id: approvalId(),
            toolName: 'file_write',
            toolCallId,
            title: t.aiFileApprovalTitle({ path }),
            detail: describeWrite(path, current, content),
            input: { path, bytes: content.length },
          },
          abortSignal,
        );
        if (decision !== 'approve') {
          return { written: false, denied: true, reason: t.aiDeniedFileWrite() };
        }

        const result = await invoke<FileWritePayload>('assistant_file_write', {
          documentPath: document,
          path,
          content,
        });
        return {
          written: true,
          ...result,
          sha256: result.sha256.slice(0, 16),
        };
      },
    }),
  };
}
