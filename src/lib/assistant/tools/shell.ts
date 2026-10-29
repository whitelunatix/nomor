import { invoke } from '@tauri-apps/api/core';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { t } from '../../../app/i18n';
import { isTauriRuntime } from '../../desktop/tauriStorage';
import { TOOL_OUTPUT_LIMIT, truncateText } from '../context';
import type { ShellResult } from '../types';

/**
 * shell 工具：执行一条命令。
 *
 * 真正的安全边界在 Rust：每次执行都会弹出原生确认框，命令原文由 Rust 拼进对话框；
 * 这里只负责把命令递过去、把输出整理成模型好读的文本。
 */

export interface ShellToolContext {
  /**
   * 当前文档的绝对路径。Rust 用它的所在目录作为工作区白名单根，
   * 并拒绝把 `cwd` 指到该目录之外；没有这个路径时工具不应注入。
   */
  documentPath: string;
  /** 原生对话框文案，由调用方按界面语言传入。 */
  labels: { title: string; allow: string; deny: string };
}

/** 取绝对路径的父目录，兼容 Windows 盘符根与 Unix 根目录。 */
export function parentDirectory(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) {
    return null;
  }
  if (index === 0) {
    return trimmed.slice(0, 1);
  }
  if (index === 2 && trimmed[1] === ':') {
    return trimmed.slice(0, 3);
  }
  return trimmed.slice(0, index);
}

function formatShellResult(result: ShellResult): string {
  const parts: string[] = [`退出码：${result.exitCode ?? '未知'}`];
  if (result.stdout.trim()) {
    parts.push(`标准输出：\n${result.stdout.trimEnd()}`);
  }
  if (result.stderr.trim()) {
    parts.push(`标准错误：\n${result.stderr.trimEnd()}`);
  }
  if (result.truncated) {
    parts.push('（输出过长，已截断）');
  }
  return truncateText(parts.join('\n\n'), TOOL_OUTPUT_LIMIT);
}

export function createShellTools(context: ShellToolContext): ToolSet {
  return {
    shell_exec: tool({
      description: [
        '在本机执行一条 shell 命令（Windows 使用 cmd /C，其他平台使用 sh -c）。',
        '每次执行都会弹出系统确认框，用户拒绝则命令不会运行。',
        '适合运行脚本、查询环境、调用命令行工具；不要用它做需要交互输入的长任务。',
      ].join('\n'),
      inputSchema: jsonSchema<{ command: string; cwd?: string; timeoutMs?: number }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令。' },
          cwd: {
            type: 'string',
            description:
              '工作目录；必须是当前文档所在目录内的绝对或相对路径，省略时使用该目录。',
          },
          timeoutMs: {
            type: 'number',
            description: '超时时间（毫秒），5000–600000，默认 120000。',
          },
        },
        required: ['command'],
        additionalProperties: false,
      }),
      execute: async ({ command, cwd, timeoutMs }, { toolCallId, abortSignal }) => {
        if (!isTauriRuntime()) {
          throw new Error(t.aiErrorShellDesktopOnly());
        }
        if (abortSignal?.aborted) {
          throw new Error(t.aiErrorCommandCancelled());
        }
        // 停止对话时把取消传给 Rust；只结束这一条命令，不影响并发调用。
        const cancel = () => {
          void invoke('assistant_shell_cancel', { callId: toolCallId }).catch(() => undefined);
        };
        abortSignal?.addEventListener('abort', cancel, { once: true });
        try {
          const workspaceRoot = parentDirectory(context.documentPath);
          if (!workspaceRoot) {
            throw new Error(t.aiErrorShellNoWorkspace());
          }
          const result = await invoke<ShellResult>('assistant_shell_exec', {
            callId: toolCallId,
            command,
            workspaceRoot,
            cwd: cwd ?? null,
            timeoutMs: typeof timeoutMs === 'number' ? Math.trunc(timeoutMs) : null,
            approvalTitle: context.labels.title,
            allowLabel: context.labels.allow,
            denyLabel: context.labels.deny,
          });
          // 确认框期间点的停止会被 Rust 忽略（命令还没开始）；这里补一刀，避免它继续跑。
          if (abortSignal?.aborted) {
            cancel();
            throw new Error(t.aiErrorCommandCancelled());
          }
          return formatShellResult(result);
        } finally {
          abortSignal?.removeEventListener('abort', cancel);
        }
      },
    }),
  };
}
