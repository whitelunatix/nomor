import { bindingAt, measureParagraph, type MeasuredParagraph } from './measure';
import { createRenderPlan, PARAGRAPH_CSS, unitStyleCss } from './renderPlan';
import { createTypographySolver } from './solver';
import { getTypographyOptions, subscribeTypography } from './options';
import { softBreakText } from './rules';
import type { ParagraphLayout, TypographyController, TypographyOptions } from './types';
import { createLineSelectionPaint } from './selectionPaint';
import { TABLE_LAYOUT_EVENT } from '../table-layout/dom';

/** Only for read-only trees. ProseMirror uses its own decoration adapter. */
export function createDomTypography(
  root: HTMLElement,
  snapshot?: TypographyOptions,
): TypographyController {
  const solver = createTypographySolver();
  const originals = new Map<HTMLElement, { children: Node[]; style: string | null }>();
  let revision = 0;
  let completed = -1;
  let destroyed = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let width = root.clientWidth;
  // 克隆只读正文会重新触发 img.load；沿克隆传递已知尺寸，不能把同一张图片反复当作新资源。
  // WeakMap 不拥有图片生命周期，只保留尺寸，不保留可能很大的 data URL。
  const loadedImages = new WeakMap<HTMLImageElement, { width: number; height: number }>();
  const imageGeometry = (image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight });
  const cloneNode = (node: Node): Node => {
    const clone = node.cloneNode(true);
    const images = node instanceof HTMLImageElement ? [node] : node instanceof Element ? [...node.querySelectorAll('img')] : [];
    const copies = clone instanceof HTMLImageElement ? [clone] : clone instanceof Element ? [...clone.querySelectorAll('img')] : [];
    images.forEach((image, index) => {
      const geometry = loadedImages.get(image) ?? (image.complete && image.naturalWidth > 0 ? imageGeometry(image) : undefined);
      if (geometry && copies[index]) loadedImages.set(copies[index], geometry);
    });
    return clone;
  };
  const selectionPaint = createLineSelectionPaint(root);
  const restore = (paragraph: HTMLElement) => {
    const original = originals.get(paragraph);
    if (!original) return;
    paragraph.replaceChildren(...original.children.map(cloneNode));
    if (original.style === null) paragraph.removeAttribute('style');
    else paragraph.setAttribute('style', original.style);
    delete paragraph.dataset.kpLayout;
    delete paragraph.dataset.kpAlignment;
    delete paragraph.dataset.kpReason;
  };
  const invalidate = () => {
    if (destroyed) return;
    solver.reset();
    revision++;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(() => {
        root.dataset.kpState = 'error';
      });
    }, 150);
  };
  const tableLayoutChanged = (event: Event) => {
    const table = event.target;
    if (table instanceof HTMLTableElement) {
      for (const paragraph of originals.keys()) if (table.contains(paragraph)) restore(paragraph);
    }
    invalidate();
  };
  root.addEventListener(TABLE_LAYOUT_EVENT, tableLayoutChanged);
  const run = async () => {
    const token = revision;
    const options = snapshot ?? getTypographyOptions();
    for (const paragraph of root.querySelectorAll<HTMLElement>('p,li,td,th')) {
      if (
        paragraph.tagName !== 'P' &&
        [...paragraph.children].some((node) =>
          /^(P|UL|OL|PRE|TABLE|DIV|FIGURE)$/.test(node.tagName),
        )
      )
        continue;
      if (paragraph.closest('pre,figure,.math-display,[contenteditable="true"]')) continue;
      if (!originals.has(paragraph))
        originals.set(paragraph, {
          children: [...paragraph.childNodes].map(cloneNode),
          style: paragraph.getAttribute('style'),
        });
      restore(paragraph);
      if (!options.enabled) continue;
      try {
        const measured = await measureParagraph(paragraph, options);
        const result = measured ? await solver.solve(measured.input) : null;
        if (destroyed || token !== revision) return;
        if (measured && result?.status === 'ready') {
          renderParagraph(paragraph, measured, result, cloneNode);
        } else {
          paragraph.dataset.kpLayout = 'fallback';
          paragraph.dataset.kpReason =
            result?.status === 'fallback' ? result.reason : 'unsupported-or-unmeasurable';
        }
      } catch {
        if (destroyed || token !== revision) return;
        restore(paragraph);
        paragraph.dataset.kpLayout = 'fallback';
        paragraph.dataset.kpReason = 'measurement-failed';
      }
    }
    selectionPaint.schedule();
    if (!destroyed && token === revision) {
      completed = token;
      root.dataset.kpState = 'complete';
    }
  };
  const flush = async () => {
    clearTimeout(timer);
    const deadline = Date.now() + 30_000;
    while (!destroyed && completed !== revision) {
      if (Date.now() > deadline) throw new Error('Typography did not settle');
      if (!running)
        running = run().finally(() => {
          running = undefined;
        });
      await running;
    }
  };
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (width !== root.clientWidth) {
            width = root.clientWidth;
            invalidate();
          }
        });
  observer?.observe(root);
  const loaded = (event: Event) => {
    if (event.target instanceof HTMLImageElement) {
      const image = event.target;
      const current = imageGeometry(image);
      const previous = loadedImages.get(image);
      if (previous?.width === current.width && previous.height === current.height) return;
      if (previous) {
        previous.width = current.width;
        previous.height = current.height;
      } else loadedImages.set(image, current);
    }
    invalidate();
  };
  root.addEventListener('load', loaded, true);
  document.fonts?.addEventListener('loadingdone', invalidate);
  const copy = (event: ClipboardEvent) => {
    const selection = window.getSelection();
    if (
      !event.clipboardData ||
      !selection?.rangeCount ||
      !root.contains(selection.anchorNode) ||
      !root.contains(selection.focusNode)
    )
      return;
    const fragment = selection.getRangeAt(0).cloneContents();
    fragment.querySelectorAll('[data-kp-owned]').forEach((node) => node.remove());
    fragment
      .querySelectorAll('[data-nomo-break],br')
      .forEach((node) => node.replaceWith(document.createTextNode('\n')));
    fragment.querySelectorAll('p').forEach((node) => node.append(document.createTextNode('\n\n')));
    event.clipboardData.setData('text/plain', fragment.textContent ?? '');
    event.preventDefault();
  };
  root.addEventListener('copy', copy);
  const unsubscribe = snapshot ? () => {} : subscribeTypography(invalidate);
  invalidate();
  return {
    flush,
    invalidate,
    destroy() {
      destroyed = true;
      revision++;
      clearTimeout(timer);
      solver.destroy();
      observer?.disconnect();
      unsubscribe();
      root.removeEventListener('load', loaded, true);
      root.removeEventListener(TABLE_LAYOUT_EVENT, tableLayoutChanged);
      document.fonts?.removeEventListener('loadingdone', invalidate);
      root.removeEventListener('copy', copy);
      selectionPaint.destroy();
      for (const paragraph of originals.keys()) restore(paragraph);
      originals.clear();
      delete root.dataset.kpState;
    },
  };
}

function renderParagraph(
  paragraph: HTMLElement,
  measured: MeasuredParagraph,
  result: ParagraphLayout,
  cloneNode: (node: Node) => Node,
) {
  const plan = createRenderPlan(measured, result);
  const styles = new Map(plan.styles.map((style) => [style.from, style]));
  const breaks = new Map(plan.breaks.map((point) => [point.at, point]));
  const nodes = new Map<Node, DocumentFragment>();
  for (const binding of measured.bindings) {
    const span = document.createElement('span');
    span.className = 'kp-unit';
    const style = styles.get(binding.from);
    if (style) span.style.cssText = unitStyleCss(style, binding.atomic);
    if (binding.atomic) {
      let copy = cloneNode(binding.node) as HTMLElement;
      if (copy.dataset.nomoBreak === 'soft') {
        copy = document.createElement('span');
        copy.dataset.nomoBreak = 'soft';
        const before = bindingAt(measured.bindings, binding.from, 'before');
        const after = bindingAt(measured.bindings, binding.to);
        copy.textContent = softBreakText(
          before?.node.textContent ?? '',
          after?.node.textContent ?? '',
        );
      }
      span.append(copy);
    } else span.textContent = binding.node.textContent!.slice(binding.offset, binding.endOffset);
    let fragment = nodes.get(binding.node);
    if (!fragment) {
      fragment = document.createDocumentFragment();
      nodes.set(binding.node, fragment);
    }
    fragment.append(span);
    const point = breaks.get(binding.to);
    if (point) {
      const br = document.createElement('span');
      br.dataset.kpOwned = 'break';
      br.setAttribute('aria-hidden', 'true');
      if (point.hyphen) br.append('-');
      br.append(document.createElement('br'));
      fragment.append(br);
    }
  }
  for (const [node, fragment] of nodes) node.parentNode?.replaceChild(fragment, node);
  paragraph.style.cssText += `;${PARAGRAPH_CSS}`;
  paragraph.dataset.kpLayout = 'ready';
  paragraph.dataset.kpAlignment = result.status === 'ready' ? (result.alignment ?? 'justify') : '';
}

/** Export waits for actual assets; timeout is an error, never a successful flush. */
export async function waitForTypographyAssets(root: HTMLElement, timeoutMs = 20_000, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout>;
  const cleanups: (() => void)[] = [];
  try {
    await Promise.race([
      Promise.all([
        document.fonts?.ready,
        ...[...root.querySelectorAll('img')].map(async (image) => {
          if (!image.complete) {
            await new Promise<void>((resolve) => {
              const done = () => {
                image.removeEventListener('load', done);
                image.removeEventListener('error', done);
                resolve();
              };
              cleanups.push(done);
              image.addEventListener('load', done, { once: true });
              image.addEventListener('error', done, { once: true });
            });
          }
          // 失败的图片已由导出资源阶段报告；成功加载后必须等解码，不能只等 load。
          if (image.naturalWidth > 0 && typeof image.decode === 'function') await image.decode();
        }),
      ]),
      new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        cleanups.push(() => signal?.removeEventListener('abort', abort));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Typography assets timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    for (const cleanup of cleanups) cleanup();
  }
}
