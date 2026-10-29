import { describe, expect, it, vi } from 'vitest';
import { createRenderTaskQueue } from './renderTaskQueue';

describe('render task scheduling', () => {
  it('bounds concurrency and skips cancelled queued work without blocking subsequent jobs', async () => {
    const run = createRenderTaskQueue(1);
    let finish!: () => void;
    const first = run(() => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    const abort = new AbortController();
    const skipped = vi.fn(async () => 'obsolete');
    const cancelled = run(skipped, abort.signal).catch(error => error.name);
    const lastTask = vi.fn(async () => 'latest');
    const last = run(lastTask);
    abort.abort();
    expect(await cancelled).toBe('AbortError');
    expect(lastTask).not.toHaveBeenCalled();
    finish();
    await first;
    expect(await last).toBe('latest');
    expect(skipped).not.toHaveBeenCalled();
  });
});
