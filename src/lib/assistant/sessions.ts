import { invoke } from '@tauri-apps/api/core';
import type {
  AssistantMessage,
  AssistantSessionMeta,
  AssistantSessionRecord,
  AssistantSessionSummary,
  AssistantUsage,
} from './types';

/** 会话文件由 Rust 写入 `<应用数据>/assistant/sessions/<id>.jsonl`，这里只做 IPC 包装。 */

export interface AssistantSessionPayload {
  meta: AssistantSessionMeta;
  records: unknown[];
  /** 损坏行等可诊断信息；读取时跳过坏行，但要让用户知道。 */
  warnings?: string[];
}

/** 每轮结束追加一行用量，不属于可展示消息。 */
export interface AssistantUsageRecord extends AssistantUsage {
  type: 'usage';
  updatedAt: number;
}

export type AssistantSessionExportFormat = 'markdown' | 'jsonl';

export interface AssistantSessionExportResult {
  path: string;
  bytes: number;
}

export function createSessionId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `s-${Date.now().toString(36)}-${random}`;
}

export async function listAssistantSessions(): Promise<AssistantSessionSummary[]> {
  return invoke<AssistantSessionSummary[]>('assistant_session_list');
}

export async function readAssistantSession(id: string): Promise<AssistantSessionPayload> {
  return invoke<AssistantSessionPayload>('assistant_session_read', { id });
}

export async function appendAssistantSession(
  id: string,
  title: string | null,
  records: unknown[],
): Promise<AssistantSessionMeta> {
  return invoke<AssistantSessionMeta>('assistant_session_append', { id, title, records });
}

/** 重新生成/编辑重发后，用完整记录原子替换会话文件。 */
export async function syncAssistantSession(
  id: string,
  title: string | null,
  records: unknown[],
): Promise<AssistantSessionMeta> {
  return invoke<AssistantSessionMeta>('assistant_session_sync', { id, title, records });
}

/** 导出到用户显式选择的路径；Rust 负责渲染与原子写入。 */
export async function exportAssistantSession(
  id: string,
  path: string,
  format: AssistantSessionExportFormat,
): Promise<AssistantSessionExportResult> {
  return invoke<AssistantSessionExportResult>('assistant_session_export', {
    id,
    path,
    format,
  });
}

export async function renameAssistantSession(
  id: string,
  title: string,
): Promise<AssistantSessionMeta> {
  return invoke<AssistantSessionMeta>('assistant_session_rename', { id, title });
}

export async function deleteAssistantSession(id: string): Promise<void> {
  await invoke('assistant_session_delete', { id });
}

export function messageToRecord(message: AssistantMessage): AssistantSessionRecord {
  return { ...message, type: 'message' };
}

export function usageToRecord(usage: AssistantUsage): AssistantUsageRecord | null {
  if (!usage || (!usage.inputTokens && !usage.outputTokens && !usage.totalTokens)) {
    return null;
  }
  return {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    updatedAt: Date.now(),
  };
}

/** 会话文件可能有多轮用量；页脚只展示最后一次。 */
export function usageFromRecords(records: unknown[]): AssistantUsage | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || typeof record !== 'object') {
      continue;
    }
    const value = record as Record<string, unknown>;
    if (value.type !== 'usage') {
      continue;
    }
    const usage: AssistantUsage = {
      inputTokens: typeof value.inputTokens === 'number' ? value.inputTokens : undefined,
      outputTokens: typeof value.outputTokens === 'number' ? value.outputTokens : undefined,
      totalTokens: typeof value.totalTokens === 'number' ? value.totalTokens : undefined,
    };
    if (usage.inputTokens || usage.outputTokens || usage.totalTokens) {
      return usage;
    }
  }
  return null;
}

/** JSONL 里可能有旧版本或被手工改坏的行；这里只保留结构完整的消息。 */
export function recordsToMessages(records: unknown[]): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    const value = record as Record<string, unknown>;
    if (value.type !== 'message' || typeof value.content !== 'string') {
      continue;
    }
    if (value.role !== 'user' && value.role !== 'assistant') {
      continue;
    }
    messages.push({
      id: typeof value.id === 'string' ? value.id : createSessionId(),
      role: value.role,
      content: value.content,
      reasoning: typeof value.reasoning === 'string' ? value.reasoning : undefined,
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
      toolCalls: Array.isArray(value.toolCalls)
        ? (value.toolCalls as AssistantMessage['toolCalls'])
        : undefined,
      error: typeof value.error === 'string' ? value.error : undefined,
      stopped: value.stopped === true ? true : undefined,
    });
  }
  return messages;
}

/** 用第一条用户消息生成会话标题。 */
export function deriveSessionTitle(text: string, maxChars = 40): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const title = (firstLine ?? '').replace(/\s+/g, ' ');
  return title.length > maxChars ? `${title.slice(0, maxChars)}…` : title;
}
