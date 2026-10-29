import { APICallError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { streamText, isStepCount, createAssistantModel } = vi.hoisted(() => ({
  streamText: vi.fn(),
  isStepCount: vi.fn((count: number) => ({ stopAfterSteps: count })),
  createAssistantModel: vi.fn(() => ({ modelId: 'fake-model' })),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, streamText, isStepCount };
});
vi.mock('./model', () => ({ createAssistantModel }));

import { DEFAULT_MAX_STEPS, describeAssistantError, runAssistantTurn } from './agent';
import type { AssistantProviderConfig } from './types';

const provider: AssistantProviderConfig = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
};

function fakeResult(
  parts: unknown[],
  options: {
    responseMessages?: unknown[];
    responseMessagesError?: unknown;
    usage?: unknown;
    usageError?: unknown;
  } = {},
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
    responseMessages: options.responseMessagesError
      ? Promise.reject(options.responseMessagesError)
      : Promise.resolve(options.responseMessages ?? []),
    usage: options.usageError
      ? Promise.reject(options.usageError)
      : Promise.resolve(options.usage ?? {}),
  };
}

function baseOptions(overrides: Partial<Parameters<typeof runAssistantTurn>[0]> = {}) {
  return {
    provider,
    history: [] as Parameters<typeof runAssistantTurn>[0]['history'],
    userText: '你好',
    system: '系统提示',
    tools: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  streamText.mockReset();
  isStepCount.mockClear();
  isStepCount.mockImplementation((count: number) => ({ stopAfterSteps: count }));
  createAssistantModel.mockClear();
});

describe('runAssistantTurn', () => {
  it('默认最多 12 步，并把历史与本轮输入一起发给模型', async () => {
    streamText.mockReturnValue(fakeResult([]));

    await runAssistantTurn(
      baseOptions({
        history: [{ role: 'assistant', content: '上一轮回答' }],
        userText: '继续',
      }),
    );

    expect(DEFAULT_MAX_STEPS).toBe(12);
    expect(isStepCount).toHaveBeenCalledWith(12);
    const call = streamText.mock.calls[0]![0];
    expect(call.messages).toEqual([
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '继续' },
    ]);
    expect(call.system).toBe('系统提示');
    expect(call.model).toEqual({ modelId: 'fake-model' });
    expect(call.stopWhen).toEqual({ stopAfterSteps: 12 });
  });

  it('允许调用方覆盖步数上限', async () => {
    streamText.mockReturnValue(fakeResult([]));

    await runAssistantTurn(baseOptions({ maxSteps: 3 }));

    expect(isStepCount).toHaveBeenCalledWith(3);
  });

  it('把文本、推理、工具调用与工具结果分派给回调', async () => {
    streamText.mockReturnValue(
      fakeResult(
        [
          { type: 'text-delta', text: '你' },
          { type: 'text-delta', text: '好' },
          { type: 'reasoning-delta', text: '想一想' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'doc_read', input: { start: 0 } },
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'doc_read',
            input: { start: 0 },
            output: { ok: true },
          },
          {
            type: 'tool-error',
            toolCallId: 'call-2',
            toolName: 'doc_read',
            input: {},
            error: new Error('文档已关闭'),
          },
          { type: 'unknown-part' },
        ],
        {
          responseMessages: [{ role: 'assistant', content: '好' }],
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      ),
    );
    const onTextDelta = vi.fn();
    const onReasoningDelta = vi.fn();
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const onToolError = vi.fn();

    const result = await runAssistantTurn(
      baseOptions({ onTextDelta, onReasoningDelta, onToolCall, onToolResult, onToolError }),
    );

    expect(onTextDelta.mock.calls.map((call) => call[0])).toEqual(['你', '好']);
    expect(onReasoningDelta).toHaveBeenCalledWith('想一想');
    expect(onToolCall).toHaveBeenCalledWith({ id: 'call-1', name: 'doc_read', input: { start: 0 } });
    expect(onToolResult).toHaveBeenCalledWith({
      id: 'call-1',
      name: 'doc_read',
      input: { start: 0 },
      output: expect.stringContaining('ok'),
    });
    expect(onToolError).toHaveBeenCalledWith({
      id: 'call-2',
      name: 'doc_read',
      input: {},
      message: '文档已关闭',
    });
    expect(result).toEqual({
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '好' },
      ],
      text: '你好',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      aborted: false,
    });
  });

  it('把用户拒绝的工具结果标记为 denied，交给界面显示「已拒绝」', async () => {
    streamText.mockReturnValue(
      fakeResult([
        {
          type: 'tool-result',
          toolCallId: 'call-9',
          toolName: 'doc_apply_edit',
          input: {},
          output: { applied: false, denied: true, reason: '用户拒绝了这次修改' },
        },
      ]),
    );
    const onToolResult = vi.fn();

    await runAssistantTurn(baseOptions({ onToolResult }));

    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'call-9',
        denied: true,
        reason: '用户拒绝了这次修改',
      }),
    );
  });

  it('流里的错误只上报一次，并保留已生成的内容', async () => {
    streamText.mockReturnValue(
      fakeResult([
        { type: 'text-delta', text: '半句' },
        { type: 'error', error: new Error('连接超时') },
        { type: 'error', error: new Error('又一个错误') },
      ]),
    );
    const onError = vi.fn();

    const result = await runAssistantTurn(baseOptions({ onError }));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('连接超时');
    expect(result.text).toBe('半句');
    expect(result.aborted).toBe(false);
  });

  it('迭代器抛错时收敛成错误回调而不是继续抛出', async () => {
    streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'a' };
        throw new Error('socket hang up');
      })(),
      responseMessages: Promise.reject(new Error('没有响应消息')),
      usage: Promise.reject(new Error('没有用量')),
    });
    const onError = vi.fn();

    const result = await runAssistantTurn(baseOptions({ onError }));

    expect(onError).toHaveBeenCalledWith('socket hang up');
    expect(result).toEqual({
      messages: [{ role: 'user', content: '你好' }],
      text: 'a',
      usage: {},
      aborted: false,
    });
  });

  it('被中止时不再上报错误，只保留用户输入', async () => {
    const controller = new AbortController();
    streamText.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: '部分' };
        throw new DOMException('aborted', 'AbortError');
      })(),
      responseMessages: Promise.reject(new Error('中止后没有响应消息')),
      usage: Promise.reject(new Error('中止后没有用量')),
    });
    const onError = vi.fn();
    controller.abort();

    const result = await runAssistantTurn(
      baseOptions({ signal: controller.signal, onError }),
    );

    expect(onError).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.messages).toEqual([{ role: 'user', content: '你好' }]);
  });
});

describe('describeAssistantError', () => {
  it('把服务商返回体收敛成一句说明', () => {
    const error = new APICallError({
      message: 'Unauthorized',
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 401,
      responseBody: '{"error":"invalid api key"}',
      isRetryable: false,
    });

    expect(describeAssistantError(error)).toBe(
      'Provider error (HTTP 401): {"error":"invalid api key"}',
    );
  });

  it('没有响应体时退回状态码与原始信息', () => {
    const error = new APICallError({
      message: 'Bad Gateway',
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 502,
      isRetryable: true,
    });

    expect(describeAssistantError(error)).toBe('Provider request failed (HTTP 502): Bad Gateway');
  });

  it('识别中止、普通错误与非 Error 值', () => {
    expect(describeAssistantError(new DOMException('x', 'AbortError'))).toBe('Stopped');
    expect(describeAssistantError(new Error('磁盘已满'))).toBe('磁盘已满');
    expect(describeAssistantError('纯字符串错误')).toBe('纯字符串错误');
  });
});
