import { codeToTokens, type BundledLanguage } from 'shiki';
import type { CodeTokenLine, CodeTokenizer } from './render';

const DEFAULT_TOKEN_CACHE_LIMIT = 120;
// 估算键、文本和 token 对象成本，不等同于浏览器实际堆占用。
const DEFAULT_TOKEN_CACHE_BYTES = 8 * 1024 * 1024;

interface ShikiCodeTokenizerOptions {
  cacheLimit?: number;
  cacheBytes?: number;
}

export function createShikiCodeTokenizer(options: ShikiCodeTokenizerOptions = {}): CodeTokenizer {
  const cache = new Map<string, { tokens: CodeTokenLine[]; bytes: number }>();
  const pending = new Map<string, Promise<CodeTokenLine[]>>();
  const cacheLimit = Math.max(1, options.cacheLimit ?? DEFAULT_TOKEN_CACHE_LIMIT);
  const cacheBytes = Math.max(0, options.cacheBytes ?? DEFAULT_TOKEN_CACHE_BYTES);
  let retainedBytes = 0;

  function remember(key: string, tokens: CodeTokenLine[]) {
    const bytes = key.length * 2 + tokens.reduce((total, line) => total + 32 + line.tokens.reduce(
      (size, token) => size + 64 + 2 * (token.content.length + (token.color?.length ?? 0) + (token.fontStyle?.length ?? 0)), 0), 0);
    retainedBytes -= cache.get(key)?.bytes ?? 0;
    cache.delete(key);
    // 单条超预算结果仅返回给调用者，不挤掉全部可复用的小结果。
    if (bytes > cacheBytes) return;
    cache.set(key, { tokens, bytes });
    retainedBytes += bytes;
    while (cache.size > cacheLimit || retainedBytes > cacheBytes) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      retainedBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
  }

  return {
    async tokenize(input) {
      const language = input.language?.trim() || 'text';
      const theme = input.theme || 'github-light';
      const key = `${language}:${theme}:${input.code}`;
      const cached = cache.get(key);

      if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return {
          language,
          tokens: cached.tokens,
        };
      }

      const existing = pending.get(key);
      if (existing) {
        return {
          language,
          tokens: await existing,
        };
      }

      const request = codeToTokens(input.code, {
        lang: language as BundledLanguage,
        theme,
      })
        .catch(() =>
          codeToTokens(input.code, {
            lang: 'text',
            theme,
          }),
        )
        .then((result) =>
          result.tokens.map((line) => ({
            tokens: line.map((token) => ({
              content: token.content,
              color: token.color,
              fontStyle: token.fontStyle ? String(token.fontStyle) : undefined,
            })),
          })),
        )
        .then((tokens) => {
          remember(key, tokens);
          return tokens;
        })
        .finally(() => {
          pending.delete(key);
        });

      pending.set(key, request);

      return {
        language,
        tokens: await request,
      };
    },
  };
}
