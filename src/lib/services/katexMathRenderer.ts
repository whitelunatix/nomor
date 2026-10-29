import katex from 'katex';
import type { MathRenderer } from './render';

export interface KatexRenderOptions {
  displayMode?: boolean;
  throwOnError?: boolean;
  strict?: 'warn' | 'ignore' | 'error' | boolean;
  trust?: boolean;
}

const KATEX_CACHE_LIMIT = 2000;
const katexHtmlCache = new Map<string, string>();

function katexCacheKey(tex: string, options: KatexRenderOptions): string {
  return [
    options.displayMode ? 'block' : 'inline',
    String(options.throwOnError ?? false),
    String(options.strict ?? ''),
    options.trust ? 'trust' : 'safe',
    tex,
  ].join('\u0000');
}

/**
 * `katex.renderToString` 的 LRU 缓存。
 *
 * 公式在正文渲染、表格单元格测量与导出序列化中会被重复渲染；论文里同一个公式
 * 往往要渲染两三次，缓存后只需一次。命中后把条目移到 Map 末尾，超出上限时
 * 淘汰最早的条目。
 */
export function renderKatexCached(tex: string, options: KatexRenderOptions = {}): string {
  const key = katexCacheKey(tex, options);
  const cached = katexHtmlCache.get(key);
  if (cached !== undefined) {
    katexHtmlCache.delete(key);
    katexHtmlCache.set(key, cached);
    return cached;
  }
  const html = katex.renderToString(tex, {
    displayMode: options.displayMode ?? false,
    throwOnError: options.throwOnError ?? false,
    strict: options.strict,
    trust: options.trust ?? false,
  });
  katexHtmlCache.set(key, html);
  while (katexHtmlCache.size > KATEX_CACHE_LIMIT) {
    const oldest = katexHtmlCache.keys().next().value;
    if (oldest === undefined) break;
    katexHtmlCache.delete(oldest);
  }
  return html;
}

export function createKatexMathRenderer(): MathRenderer {
  return {
    async render(tex, options) {
      try {
        return {
          html: renderKatexCached(tex, {
            displayMode: options.displayMode,
            throwOnError: false,
            strict: 'ignore',
          }),
        };
      } catch (error) {
        return {
          html: '',
          error: error instanceof Error ? error.message : '公式渲染失败',
        };
      }
    },
  };
}
