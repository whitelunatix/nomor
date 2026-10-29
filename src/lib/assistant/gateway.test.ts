import { beforeEach, describe, expect, it, vi } from 'vitest';

type GatewayEvent =
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

interface FakeChannelInstance {
  onmessage: ((event: GatewayEvent) => void) | null;
  emit(event: GatewayEvent): void;
}

const { invoke, FakeChannel } = vi.hoisted(() => {
  class FakeChannelImpl {
    static instances: FakeChannelImpl[] = [];
    onmessage: ((event: GatewayEvent) => void) | null = null;

    constructor() {
      FakeChannelImpl.instances.push(this);
    }

    emit(event: GatewayEvent): void {
      this.onmessage?.(event);
    }
  }
  return { invoke: vi.fn(), FakeChannel: FakeChannelImpl };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: FakeChannel }));

import { createGatewayFetch } from './gateway';

function lastChannel(): FakeChannelInstance {
  const channel = (FakeChannel.instances as FakeChannelInstance[]).at(-1);
  if (!channel) {
    throw new Error('channel 未创建');
  }
  return channel;
}

beforeEach(() => {
  invoke.mockReset();
  FakeChannel.instances = [];
});

describe('createGatewayFetch', () => {
  it('把请求原样交给 Rust，并把 Channel 分片拼成响应流', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'assistant_stream_start') {
        return {
          status: 200,
          headers: [
            ['content-type', 'text/event-stream'],
            ['content-length', '999'],
            ['transfer-encoding', 'chunked'],
          ],
        };
      }
      return undefined;
    });
    const fetchFn = createGatewayFetch({ providerId: 'deepseek', auth: 'bearer' });

    const response = await fetchFn('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: '{"messages":[]}',
      headers: { 'content-type': 'application/json' },
    });

    expect(invoke).toHaveBeenCalledWith('assistant_stream_start', {
      request: {
        streamId: expect.any(String),
        providerId: 'deepseek',
        url: 'https://api.example.com/v1/chat/completions',
        headers: [['content-type', 'application/json']],
        body: '{"messages":[]}',
        auth: 'bearer',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    // 重新生造响应后长度/编码头已失真，必须丢掉。
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('transfer-encoding')).toBeNull();

    const channel = lastChannel();
    channel.emit({ type: 'chunk', data: '第一段' });
    channel.emit({ type: 'chunk', data: '第二段' });
    channel.emit({ type: 'end' });

    await expect(response.text()).resolves.toBe('第一段第二段');
  });

  it('Rust 报错时让响应流以该错误失败', async () => {
    invoke.mockResolvedValue({ status: 200, headers: [] });
    const fetchFn = createGatewayFetch({ providerId: 'p', auth: 'xApiKey' });

    const response = await fetchFn('https://api.example.com/messages', { body: '{}' });
    lastChannel().emit({ type: 'error', message: '连接被重置' });

    await expect(response.text()).rejects.toThrow('连接被重置');
  });

  it('取消响应体时通知 Rust 停止远端流', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'assistant_stream_start' ? { status: 200, headers: [] } : undefined,
    );
    const fetchFn = createGatewayFetch({ providerId: 'p', auth: 'bearer' });

    const response = await fetchFn('https://api.example.com/v1/chat/completions', { body: '{}' });
    await response.body!.cancel();

    expect(invoke).toHaveBeenCalledWith('assistant_stream_cancel', {
      streamId: expect.any(String),
    });
  });

  it('abort 信号触发时以 AbortError 结束并停止远端流', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'assistant_stream_start' ? { status: 200, headers: [] } : undefined,
    );
    const fetchFn = createGatewayFetch({ providerId: 'p', auth: 'bearer' });
    const controller = new AbortController();

    const response = await fetchFn('https://api.example.com/v1/chat/completions', {
      body: '{}',
      signal: controller.signal,
    });
    controller.abort();

    await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('assistant_stream_cancel', {
      streamId: expect.any(String),
    });
  });

  it('204 等无响应体状态直接返回空响应，不挂载流', async () => {
    invoke.mockResolvedValue({ status: 204, headers: [] });
    const fetchFn = createGatewayFetch({ providerId: 'p', auth: 'bearer' });

    const response = await fetchFn('https://api.example.com/v1/chat/completions', { body: '{}' });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('start 调用失败时把原始错误抛给调用方', async () => {
    invoke.mockRejectedValue('无法连接本地网关');
    const fetchFn = createGatewayFetch({ providerId: 'p', auth: 'bearer' });

    await expect(fetchFn('https://api.example.com/v1/chat/completions', { body: '{}' })).rejects.toThrow(
      '无法连接本地网关',
    );
  });
});
