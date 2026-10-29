import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../desktop/tauriStorage';
import type {
  McpConfigView,
  McpHealthResult,
  McpImportResult,
  McpImportSource,
  McpServerTools,
  McpToolInfo,
} from './types';

/**
 * MCP 配置与调用的前端入口。
 *
 * 配置只有一份：应用数据目录下的 `mcp.json`，格式是通用的 `mcpServers` 对象。
 * 子进程、HTTP 连接和密钥都留在 Rust 侧，这里只做数据搬运。
 */

export async function readMcpConfig(): Promise<McpConfigView | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<McpConfigView>('assistant_mcp_config_read');
}

export async function writeMcpConfig(text: string): Promise<McpConfigView> {
  return invoke<McpConfigView>('assistant_mcp_config_write', { text });
}

export async function setMcpTrusted(id: string, trusted: boolean): Promise<McpConfigView> {
  return invoke<McpConfigView>('assistant_mcp_set_trusted', { id, trusted });
}

export async function connectMcpServer(id: string): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>('assistant_mcp_connect', { id });
}

export async function disconnectMcpServer(id: string): Promise<void> {
  await invoke('assistant_mcp_disconnect', { id });
}

/** 收集所有启用服务器的工具；单个服务器连不上时 Rust 会跳过它并记录错误。 */
export async function loadMcpTools(): Promise<McpServerTools[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<McpServerTools[]>('assistant_mcp_tools');
}

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 生成合法 callId：优先复用 AI SDK 的 toolCallId（多数服务商都符合字符约束），
 * 否则退回随机 id。取消命令只认这个 id，所以必须在调用前确定。
 */
export function createMcpCallId(seed?: string): string {
  if (seed && CALL_ID_PATTERN.test(seed)) {
    return seed;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '_');
  }
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 调用 MCP 工具；`signal` 中止时只取消这一次调用（Rust 侧 abort 对应任务），
 * 不会断开复用的连接，也不会误杀并发调用。
 */
export async function callMcpTool(
  serverId: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  callId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = createMcpCallId(callId);
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const cancel = () => {
    void invoke('assistant_mcp_call_cancel', { callId: id }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await invoke('assistant_mcp_call', {
      serverId,
      tool,
      arguments: args ?? null,
      callId: id,
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** 健康检查；给 `id` 时检查并视需要重连，否则只探活已连接服务器。 */
export async function checkMcpHealth(id?: string, force = false): Promise<McpHealthResult[]> {
  return invoke<McpHealthResult[]>('assistant_mcp_health', {
    id: id ?? null,
    force,
  });
}

export async function scanMcpImports(workspaceRoot?: string | null): Promise<McpImportSource[]> {
  return invoke<McpImportSource[]>('assistant_mcp_import_scan', {
    workspaceRoot: workspaceRoot ?? null,
  });
}

export async function importMcpConfig(
  kind: string,
  options: { workspaceRoot?: string | null; replaceExisting?: boolean } = {},
): Promise<McpImportResult> {
  return invoke<McpImportResult>('assistant_mcp_import', {
    kind,
    workspaceRoot: options.workspaceRoot ?? null,
    replaceExisting: options.replaceExisting ?? false,
  });
}

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * 工具名清洗成 `[A-Za-z0-9_-]`，OpenAI 与 Anthropic 都只接受这些字符。
 * 服务器 id 和工具名本身由用户/第三方决定，不能直接拼进函数名。
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const raw = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return raw.slice(0, MAX_TOOL_NAME_LENGTH);
}
