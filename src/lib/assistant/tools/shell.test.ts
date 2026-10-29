import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, isTauriRuntime } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../desktop/tauriStorage', () => ({ isTauriRuntime }));

import { createShellTools, parentDirectory } from './shell';

const labels = { title: '允许执行命令？', allow: '允许', deny: '拒绝' };

async function runTool(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const definition = tools[name] as unknown as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return definition.execute(input, {
    toolCallId: 'call-1',
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

beforeEach(() => {
  invoke.mockReset();
  isTauriRuntime.mockReturnValue(true);
});

describe('createShellTools', () => {
  it('把命令与本地化文案一起交给 Rust，并整理输出', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      stdout: '中文输出\n',
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    const tools = createShellTools({
      documentPath: 'C:\\work\\draft.md',
      labels,
    });

    const result = await runTool(tools, 'shell_exec', { command: 'echo 中文' });

    expect(invoke).toHaveBeenCalledWith('assistant_shell_exec', {
      callId: 'call-1',
      command: 'echo 中文',
      workspaceRoot: 'C:\\work',
      cwd: null,
      timeoutMs: null,
      approvalTitle: labels.title,
      allowLabel: labels.allow,
      denyLabel: labels.deny,
    });
    expect(String(result)).toContain('退出码：0');
    expect(String(result)).toContain('中文输出');
  });

  it('单次调用传入的 cwd 原样交给 Rust 校验，并始终带上工作区根', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
    });
    const tools = createShellTools({
      documentPath: 'C:\\work\\draft.md',
      labels,
    });

    await runTool(tools, 'shell_exec', { command: 'dir', cwd: 'D:\\docs' });

    expect(invoke.mock.calls[0]![1]).toMatchObject({
      workspaceRoot: 'C:\\work',
      cwd: 'D:\\docs',
    });
  });

  it('用户拒绝时把 Rust 的错误抛给模型', async () => {
    invoke.mockRejectedValue('用户拒绝了这次命令执行');
    const tools = createShellTools({ documentPath: 'C:\\work\\draft.md', labels });

    await expect(runTool(tools, 'shell_exec', { command: 'del /q *' })).rejects.toBe(
      '用户拒绝了这次命令执行',
    );
  });

  it('超长输出会截断，避免撑爆上下文', async () => {
    invoke.mockResolvedValue({
      exitCode: 0,
      stdout: 'x'.repeat(50_000),
      stderr: '',
      truncated: true,
      timedOut: false,
    });
    const tools = createShellTools({ documentPath: 'C:\\work\\draft.md', labels });

    const result = String(await runTool(tools, 'shell_exec', { command: 'dir /s' }));

    expect(result.length).toBeLessThan(9_000);
    expect(result).toContain('已省略');
  });
});

describe('parentDirectory', () => {
  it('兼容 Windows 盘符根、反斜杠与 Unix 根目录', () => {
    expect(parentDirectory('C:\\work\\notes\\draft.md')).toBe('C:\\work\\notes');
    expect(parentDirectory('C:\\draft.md')).toBe('C:\\');
    expect(parentDirectory('/home/user/draft.md')).toBe('/home/user');
    expect(parentDirectory('/draft.md')).toBe('/');
    expect(parentDirectory('relative.md')).toBeNull();
    expect(parentDirectory('   ')).toBeNull();
  });
});
