/**
 * 工具执行前的人工审批队列。
 *
 * 审批发生在工具的 `execute` 里：`execute` 先 await 这里的结果，用户点「允许」才继续。
 * 这样工具循环本身不需要暂停/恢复机制，AI SDK 的多步执行也能照常工作。
 */

export type ApprovalDecision = 'approve' | 'deny';

export interface ApprovalRequest {
  id: string;
  /** 工具名，例如 `doc_apply_edit`、`shell_exec`。 */
  toolName: string;
  /** SDK 的 toolCallId；用于把「等待确认」状态对回工具卡片。 */
  toolCallId?: string;
  /** 一句话说明要做什么。 */
  title: string;
  /** 需要用户核对的内容：命令行、diff 等。 */
  detail?: string;
  input: unknown;
}

export type ApprovalListener = (request: ApprovalRequest | null) => void;

export class ApprovalBroker {
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
  private queue: ApprovalRequest[] = [];
  private readonly listeners = new Set<ApprovalListener>();

  /** 当前展示给用户的请求；同一时刻只显示队首。 */
  getCurrent(): ApprovalRequest | null {
    return this.queue[0] ?? null;
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    listener(this.getCurrent());
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted) {
      return Promise.resolve('deny');
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (decision: ApprovalDecision) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const onAbort = () => {
        this.pending.delete(request.id);
        this.queue = this.queue.filter((item) => item.id !== request.id);
        this.emit();
        settle('deny');
      };

      this.pending.set(request.id, (decision) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(decision);
      });
      this.queue.push(request);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.emit();
    });
  }

  /** 用户点击了某个请求；返回 false 表示该请求已经结束（例如被中止）。 */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const resolver = this.pending.get(id);
    if (!resolver) {
      return false;
    }
    this.pending.delete(id);
    this.queue = this.queue.filter((item) => item.id !== id);
    this.emit();
    resolver(decision);
    return true;
  }

  /** 中止整轮对话时使用：所有未决请求按拒绝处理。 */
  cancelAll(): void {
    const resolvers = [...this.pending.values()];
    this.pending.clear();
    this.queue = [];
    this.emit();
    for (const resolve of resolvers) {
      resolve('deny');
    }
  }

  private emit(): void {
    const current = this.getCurrent();
    for (const listener of this.listeners) {
      listener(current);
    }
  }
}
