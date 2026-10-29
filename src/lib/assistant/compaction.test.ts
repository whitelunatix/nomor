import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTranscript,
  compactHistory,
  DEGRADED_TARGET_TOKENS,
  estimateMessagesTokens,
  splitHistory,
  summaryChunks,
} from './compaction';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

function turns(count: number, size = 10): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let index = 1; index <= count; index += 1) {
    messages.push(user(`问题 ${index} ${'字'.repeat(size)}`));
    messages.push(assistant(`回答 ${index} ${'字'.repeat(size)}`));
  }
  return messages;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('splitHistory', () => {
  it('保留最近 4 轮，并从 user 边界切分', () => {
    const history = turns(6);
    const { older, kept } = splitHistory(history);

    expect(older).toHaveLength(4);
    expect(kept[0]!.role).toBe('user');
    expect(kept).toHaveLength(8);
    expect(String(older.at(-1)!.content)).toContain('回答 2');
    expect(String(kept[0]!.content)).toContain('问题 3');
  });

  it('轮数不足时不切分', () => {
    const history = turns(3);
    expect(splitHistory(history).older).toEqual([]);
    expect(splitHistory(history).kept).toEqual(history);
  });
});

describe('buildTranscript', () => {
  it('把工具调用与结果压成一行，并截断长内容', () => {
    const history: ModelMessage[] = [
      user('查一下目录'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolName: 'file_list', input: { path: '.' } },
        ] as never,
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolName: 'file_list',
            output: { entries: ['a.md'] },
          },
        ] as never,
      },
    ];

    const transcript = buildTranscript(history);
    expect(transcript).toContain('[调用 file_list: {"path":"."}]');
    expect(transcript).toContain('[结果 file_list: {"entries":["a.md"]}]');
    expect(transcript).toContain('[用户] 查一下目录');
  });

  it('长消息在 transcript 里被截断，避免摘要输入爆掉', () => {
    const transcript = buildTranscript([user('字'.repeat(10_000))]);
    expect(transcript.length).toBeLessThan(5_000);
    expect(transcript).toContain('已省略');
  });
});

describe('summaryChunks', () => {
  it('超过 4 块时只保留最近 4 块并注明省略', () => {
    const chunks = summaryChunks('x'.repeat(16_000 * 6));
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toContain('更早的对话已省略');
  });
});

describe('compactHistory', () => {
  it('未到触发阈值时不调用摘要模型', async () => {
    const generate = vi.fn(async () => '摘要');
    const history = turns(4);
    const result = await compactHistory({
      history,
      previousSummary: null,
      signal: signal(),
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.history).toEqual(history);
    expect(result.compacted).toBe(false);
  });

  it('超过阈值时折叠较早消息并带上摘要', async () => {
    const generate = vi.fn(async (_input: string, _signal: AbortSignal) => '较早对话的摘要');
    const history = turns(6, 5_500);
    expect(estimateMessagesTokens(history)).toBeGreaterThan(60_000);
    expect(estimateMessagesTokens(history)).toBeLessThan(75_000);

    const result = await compactHistory({
      history,
      previousSummary: '旧摘要',
      signal: signal(),
      generate,
    });

    expect(generate).toHaveBeenCalled();
    // 第一次摘要输入里带上了旧摘要。
    expect(String(generate.mock.calls[0]![0])).toContain('旧摘要');
    expect(result.compacted).toBe(true);
    expect(result.summary).toBe('较早对话的摘要');
    expect(result.history.length).toBeLessThan(history.length);
    expect(result.history[0]!.role).toBe('user');
    expect(result.summaryFailed).toBe(false);
  });

  it('摘要失败时保留旧摘要与历史，不阻断本轮', async () => {
    const generate = vi.fn(async () => {
      throw new Error('provider down');
    });
    const history = turns(6, 6_000);

    const result = await compactHistory({
      history,
      previousSummary: '旧摘要',
      signal: signal(),
      generate,
    });

    expect(result.summaryFailed).toBe(true);
    expect(result.summary).toBe('旧摘要');
    expect(result.history).toEqual(history);
    expect(result.degraded).toBe(false);
  });

  it('摘要失败且仍超硬上限时丢弃最旧消息，至少保留 2 轮', async () => {
    const generate = vi.fn(async () => {
      throw new Error('provider down');
    });
    const history = turns(6, 10_000);

    const result = await compactHistory({
      history,
      previousSummary: '旧摘要',
      signal: signal(),
      generate,
    });

    expect(result.summaryFailed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.summary).toBe('旧摘要');
    expect(result.history.length).toBeLessThan(history.length);
    expect(result.history[0]!.role).toBe('user');
    expect(
      estimateMessagesTokens(result.history) + 10,
    ).toBeLessThanOrEqual(DEGRADED_TARGET_TOKENS + 100);
  });

  it('已中止的对话不会调用摘要模型', async () => {
    const generate = vi.fn(async () => '摘要');
    const controller = new AbortController();
    controller.abort();
    const history = turns(6, 15_000);

    const result = await compactHistory({
      history,
      previousSummary: null,
      signal: controller.signal,
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.summaryFailed).toBe(true);
    expect(result.history).toEqual(history);
  });
});
