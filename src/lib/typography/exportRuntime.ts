import { createDomTypography, waitForTypographyAssets } from './dom';
import { DEFAULT_TYPOGRAPHY, type TypographyOptions } from './types';
import { createExportTableLayout } from '../table-layout/export';
import { preparePrintDocument, classifyPrintBlocks } from './exportPrint';

declare global {
  interface Window {
    __NOMO_FLUSH_TYPOGRAPHY__?: () => Promise<void>;
    __NOMO_PREPARE_PRINT__?: (widthMm: number, heightMm?: number) => Promise<void>;
  }
}

const root = document.querySelector<HTMLElement>('.nomo-export');
if (root) {
  const options: TypographyOptions = {
    ...DEFAULT_TYPOGRAPHY,
    ...JSON.parse(document.getElementById('nomo-typography-options')?.textContent ?? '{}'),
  };
  const controller = createDomTypography(root, options);
  const tables = createExportTableLayout(root);
  let printing = false;
  const abort = new AbortController();
  let pending = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const result = pending.then(() => { abort.signal.throwIfAborted(); return operation(); });
    pending = result.catch(() => undefined);
    return result;
  };
  const flush = async () => {
    await waitForTypographyAssets(root, 20_000, abort.signal);
    abort.signal.throwIfAborted();
    await tables.flush(printing);
    controller.invalidate();
    await controller.flush();
  };
  window.__NOMO_FLUSH_TYPOGRAPHY__ = () => enqueue(flush);
  // HTML 中展开原生 details 后再布局此前隐藏的段落/表格；同一帧只刷新一次。
  let detailsFrame = 0;
  root.addEventListener('toggle', event => {
    if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || printing || detailsFrame) return;
    detailsFrame = requestAnimationFrame(() => {
      detailsFrame = 0;
      void enqueue(flush).catch(() => { if (!abort.signal.aborted) root.dataset.kpState = 'error'; });
    });
  }, { capture: true, signal: abort.signal });
  window.__NOMO_PREPARE_PRINT__ = (widthMm, heightMm = 257) => enqueue(async () => {
    preparePrintDocument(root, widthMm, heightMm);
    printing = true;
    await flush();
    abort.signal.throwIfAborted();
    classifyPrintBlocks(root, heightMm);
  });
  window.addEventListener('pagehide', () => { abort.abort(); cancelAnimationFrame(detailsFrame); tables.destroy(); controller.destroy(); }, { once: true });
  void window.__NOMO_FLUSH_TYPOGRAPHY__().catch(() => {
    root.dataset.kpState = 'error';
  });
}
