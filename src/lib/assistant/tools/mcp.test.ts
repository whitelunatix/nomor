import type { ToolSet } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { ApprovalBroker, type ApprovalDecision } from '../approval';
import { mcpToolName } from '../mcp';
import type { McpServerTools } from '../types';
import { createMcpTools } from './mcp';

function server(overrides: Partial<McpServerTools> = {}): McpServerTools {
  return {
    serverId: 'word-operation',
    trusted: false,
    tools: [
      {
        name: 'word_query',
        description: '查询文档',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        readOnly: true,
      },
      {
        name: 'word_sync',
        description: '写入文档',
        inputSchema: { type: 'object', properties: {} },
        readOnly: false,
      },
    ],
    ...overrides,
  };
}

async function runTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  signal = new AbortController().signal,
): Promise<unknown> {
  const definition = tools[name] as unknown as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return definition.execute(input, {
    toolCallId: 'call-1',
    messages: [],
    abortSignal: signal,
  });
}

function autoDecide(broker: ApprovalBroker, decision: ApprovalDecision): () => void {
  return broker.subscribe((request) => {
    if (request) {
      broker.resolve(request.id, decision);
    }
  });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
});

describe('mcpToolName', () => {
  it('把非法字符替换成下划线', () => {
    expect(mcpToolName('my server', 'tool.name')).toBe('mcp__my_server__tool_name');
  });

  it('截断到 64 个字符以内', () => {
    const name = mcpToolName('a'.repeat(40), 'b'.repeat(60));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith('mcp__')).toBe(true);
  });
});

describe('createMcpTools', () => {
  it('为每个服务器工具生成带命名空间的工具', () => {
    const tools = createMcpTools({
      servers: [server()],
      approval: new ApprovalBroker(),
    });
    expect(Object.keys(tools).sort()).toEqual([
      'mcp__word-operation__word_query',
      'mcp__word-operation__word_sync',
    ]);
  });

  it('可信服务器上的只读工具自动放行', async () => {
    const broker = new ApprovalBroker();
    const tools = createMcpTools({
      servers: [server({ trusted: true })],
      approval: broker,
    });

    const result = await runTool(tools, 'mcp__word-operation__word_query', { path: 'a.docx' });

    expect(broker.getCurrent()).toBeNull();
    expect(invoke).toHaveBeenCalledWith('assistant_mcp_call', {
      serverId: 'word-operation',
      tool: 'word_query',
      arguments: { path: 'a.docx' },
      callId: 'call-1',
    });
    expect(String(result)).toContain('ok');
  });

  it('中止信号只取消当前 callId，不影响连接', async () => {
    const controller = new AbortController();
    let resolveCall: (value: unknown) => void = () => undefined;
    invoke.mockImplementation((command: string) => {
      if (command === 'assistant_mcp_call') {
        return new Promise((resolve) => {
          resolveCall = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const tools = createMcpTools({
      servers: [server({ trusted: true })],
      approval: new ApprovalBroker(),
    });

    const pending = runTool(tools, 'mcp__word-operation__word_query', {}, controller.signal);
    controller.abort();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith('assistant_mcp_call_cancel', { callId: 'call-1' });
    expect(invoke).not.toHaveBeenCalledWith(
      'assistant_mcp_disconnect',
      expect.anything(),
    );

    resolveCall({ content: [] });
    await pending;
  });

  it('写类工具即使服务器可信也要审批', async () => {
    const broker = new ApprovalBroker();
    const tools = createMcpTools({
      servers: [server({ trusted: true })],
      approval: broker,
    });

    const pending = runTool(tools, 'mcp__word-operation__word_sync', { file: 'a.docx' });
    const request = broker.getCurrent();
    expect(request?.toolName).toBe('mcp__word-operation__word_sync');
    expect(request?.title).toContain('word-operation');
    broker.resolve(request!.id, 'approve');

    await pending;
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('用户拒绝时返回错误结果且不调用服务器', async () => {
    const broker = new ApprovalBroker();
    const tools = createMcpTools({
      servers: [server()],
      approval: broker,
    });
    const unsubscribe = autoDecide(broker, 'deny');

    const result = await runTool(tools, 'mcp__word-operation__word_sync', {});

    unsubscribe();
    expect(result).toEqual({ denied: true, reason: 'The user denied this tool call' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('清洗后重名的工具会加序号，不互相覆盖', () => {
    const tools = createMcpTools({
      servers: [
        server({
          serverId: 's',
          tools: [
            { name: 'a.b', description: '', inputSchema: {}, readOnly: true },
            { name: 'a b', description: '', inputSchema: {}, readOnly: true },
          ],
        }),
      ],
      approval: new ApprovalBroker(),
    });
    expect(Object.keys(tools).sort()).toEqual(['mcp__s__a_b', 'mcp__s__a_b_2']);
  });
});
