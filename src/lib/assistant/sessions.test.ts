import { describe, expect, it } from 'vitest';
import { messageToRecord, recordsToMessages, usageFromRecords, usageToRecord } from './sessions';
import type { AssistantMessage } from './types';

describe('assistant session records', () => {
  it('用量记录持久化后可还原，最后一条生效', () => {
    const first = usageToRecord({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const second = usageToRecord({ inputTokens: 20, outputTokens: 8 });
    expect(first?.type).toBe('usage');
    expect(second?.totalTokens).toBe(28);

    expect(usageFromRecords([first, second])).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
    });
  });

  it('没有可用用量时返回 null，不伪造 0', () => {
    expect(usageToRecord({})).toBeNull();
    expect(usageFromRecords([{ type: 'usage' }, { type: 'message' }])).toBeNull();
  });

  it('消息记录与用量记录混排时只还原消息', () => {
    const message: AssistantMessage = {
      id: 'm-1',
      role: 'assistant',
      content: '回答',
      createdAt: 1,
      toolCalls: [
        {
          id: 'call-1',
          name: 'doc_outline',
          title: 'doc_outline',
          status: 'success',
          startedAt: 10,
          finishedAt: 20,
        },
      ],
    };
    const records = [
      messageToRecord(message),
      usageToRecord({ inputTokens: 3, outputTokens: 4, totalTokens: 7 }),
    ];

    const restored = recordsToMessages(records);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.content).toBe('回答');
    // 耗时字段随消息落盘，重启后工具卡片仍能显示耗时。
    expect(restored[0]?.toolCalls?.[0]?.startedAt).toBe(10);
    expect(restored[0]?.toolCalls?.[0]?.finishedAt).toBe(20);
  });
});
