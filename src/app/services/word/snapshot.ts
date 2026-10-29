import type { WordExportInput } from '../wordExportService';
import { t } from '../../i18n';
import { withWordAbort } from './resources';

interface WordSnapshotTarget {
  disposed: boolean;
  editor: { awaitCompositionEnd?(): Promise<void>; getMarkdown(): string };
  sourceEditor?: { isComposing?(): boolean };
}

/** 所有异步等待绑定触发时的文档，不能在等待后重新读取全局活动标签。 */
export async function captureWordSnapshot(
  tab: { id: string; nativePath: string | null; fileName: string },
  runtime: WordSnapshotTarget,
  options: { signal: AbortSignal; isAvailable(): boolean; flush(tabId: string): void },
): Promise<WordExportInput | null> {
  await withWordAbort(runtime.editor.awaitCompositionEnd?.() ?? Promise.resolve(), options.signal, 30_000);
  const deadline = performance.now() + 30_000;
  while (runtime.sourceEditor?.isComposing?.()) {
    options.signal.throwIfAborted();
    if (runtime.disposed || !options.isAvailable()) return null;
    if (performance.now() > deadline) throw new Error(t.wordExportTimeout());
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  options.signal.throwIfAborted();
  if (runtime.disposed || !options.isAvailable()) return null;
  options.flush(tab.id);
  return {
    markdown: runtime.editor.getMarkdown(), documentPath: tab.nativePath,
    suggestedFileName: tab.fileName.replace(/\.(md|markdown)$/i, '') || 'Untitled', title: tab.fileName || 'Untitled',
  };
}
