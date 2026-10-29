import type { MermaidThemeDefinition } from '../../../lib/theme/types';
import type { TypographyOptions } from '../../../lib/typography/types';

/** 导出只持有值快照，不保留编辑器、组件回调或旧 DOM。 */
export interface ExportAppearance {
  readonly cssVariables: Readonly<Record<string, string>>;
  readonly attributes: Readonly<Record<string, string>>;
  readonly maxWidthPx: number;
  readonly typography: Readonly<TypographyOptions>;
  readonly shikiTheme: string;
  readonly mermaid: Readonly<MermaidThemeDefinition>;
  readonly locale: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ExportSnapshot {
  readonly documentId: string;
  readonly contentRevision: number;
  readonly markdown: string;
  readonly documentPath: string | null;
  readonly suggestedFileName: string;
  readonly title: string;
  readonly appearance: ExportAppearance;
}

export interface ExportTaskOptions {
  signal?: AbortSignal;
}

export function throwIfExportAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** 有界等待；迟到的结果不能继续提交。调用者仍负责释放底层资源。 */
export function awaitExport<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    const timer = setTimeout(() => finish(() => reject(new Error('导出等待超时'))), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
