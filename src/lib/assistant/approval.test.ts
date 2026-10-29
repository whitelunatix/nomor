import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, type ApprovalRequest } from './approval';

function request(id: string, toolName = 'doc_apply_edit'): ApprovalRequest {
  return { id, toolName, title: `执行 ${toolName}`, input: { id } };
}

describe('ApprovalBroker', () => {
  it('批准后 promise 得到 approve，并且队列清空', async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request(request('a'));
    expect(broker.getCurrent()?.id).toBe('a');

    expect(broker.resolve('a', 'approve')).toBe(true);
    await expect(pending).resolves.toBe('approve');
    expect(broker.getCurrent()).toBeNull();
  });

  it('拒绝后得到 deny', async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request(request('a'));
    broker.resolve('a', 'deny');
    await expect(pending).resolves.toBe('deny');
  });

  it('多个请求按 FIFO 依次展示', async () => {
    const broker = new ApprovalBroker();
    const first = broker.request(request('a'));
    const second = broker.request(request('b'));
    expect(broker.getCurrent()?.id).toBe('a');

    broker.resolve('a', 'approve');
    await first;
    expect(broker.getCurrent()?.id).toBe('b');

    broker.resolve('b', 'deny');
    await expect(second).resolves.toBe('deny');
  });

  it('resolve 未知 id 返回 false', () => {
    const broker = new ApprovalBroker();
    expect(broker.resolve('missing', 'approve')).toBe(false);
  });

  it('重复 resolve 同一个 id 只生效一次', async () => {
    const broker = new ApprovalBroker();
    const pending = broker.request(request('a'));
    expect(broker.resolve('a', 'approve')).toBe(true);
    expect(broker.resolve('a', 'deny')).toBe(false);
    await expect(pending).resolves.toBe('approve');
  });

  it('cancelAll 把所有未决请求按拒绝处理', async () => {
    const broker = new ApprovalBroker();
    const first = broker.request(request('a'));
    const second = broker.request(request('b'));
    broker.cancelAll();
    await expect(first).resolves.toBe('deny');
    await expect(second).resolves.toBe('deny');
    expect(broker.getCurrent()).toBeNull();
  });

  it('signal 已中止时直接拒绝，不进队列', async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.request(request('a'), controller.signal)).resolves.toBe('deny');
    expect(broker.getCurrent()).toBeNull();
  });

  it('请求挂起后中止 signal：移出队列并拒绝', async () => {
    const broker = new ApprovalBroker();
    const controller = new AbortController();
    const pending = broker.request(request('a'), controller.signal);
    expect(broker.getCurrent()?.id).toBe('a');

    controller.abort();
    await expect(pending).resolves.toBe('deny');
    expect(broker.getCurrent()).toBeNull();
    // 中止后不能再被 resolve。
    expect(broker.resolve('a', 'approve')).toBe(false);
  });

  it('订阅时立刻收到当前请求，resolve 后收到 null', async () => {
    const broker = new ApprovalBroker();
    const seen: Array<string | null> = [];
    const unsubscribe = broker.subscribe((current) => {
      seen.push(current?.id ?? null);
    });
    expect(seen).toEqual([null]);

    const pending = broker.request(request('a'));
    expect(seen).toEqual([null, 'a']);

    broker.resolve('a', 'approve');
    await pending;
    expect(seen).toEqual([null, 'a', null]);

    unsubscribe();
    broker.request(request('b'));
    expect(seen).toEqual([null, 'a', null]);
  });

  it('取消订阅后不再收到通知', () => {
    const broker = new ApprovalBroker();
    const listener = vi.fn();
    const unsubscribe = broker.subscribe(listener);
    unsubscribe();
    broker.request(request('a'));
    expect(listener).toHaveBeenCalledTimes(1); // 只有订阅时的初始调用
  });
});
