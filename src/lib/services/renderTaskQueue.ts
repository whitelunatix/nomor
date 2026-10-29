/** 限制昂贵增强任务并发；取消排队项时立即释放闭包，已运行的库调用只等待其结束。 */
export function createRenderTaskQueue(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function drain() {
    while (active < concurrency && queue.length) queue.shift()!();
  }
  return function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (started) return;
        const index = queue.indexOf(start);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener('abort', abort);
        reject(new DOMException('Render cancelled', 'AbortError'));
      };
      const start = () => {
        started = true;
        active++;
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return task();
        }).then(resolve, reject).finally(() => {
          signal?.removeEventListener('abort', abort);
          active--;
          drain();
        });
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(start);
      drain();
    });
  };
}
