import { describe, expect, it } from 'vitest';
import {
  TOOL_OUTPUT_LIMIT,
  estimateTokens,
  formatToolOutput,
  stringifyToolOutput,
  truncateText,
} from './context';

describe('estimateTokens', () => {
  it('空字符串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按字计，英文按 4 字符计', () => {
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('中文abcd')).toBe(3);
  });

  it('非空短文本至少算 1 个 token', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('truncateText', () => {
  it('不超过上限时原样返回', () => {
    expect(truncateText('短文本', 10)).toBe('短文本');
    expect(truncateText('短文本', 3)).toBe('短文本');
  });

  it('超长时保留头尾并标注省略数量', () => {
    const text = 'a'.repeat(100);
    const result = truncateText(text, 20);
    expect(result).toContain('已省略 80 个字符');
    // 70% 头 + 30% 尾。
    expect(result.startsWith('a'.repeat(14))).toBe(true);
    expect(result.endsWith('a'.repeat(6))).toBe(true);
  });

  it('maxChars 为 0 或负数时视为不截断', () => {
    expect(truncateText('abc', 0)).toBe('abc');
    expect(truncateText('abc', -1)).toBe('abc');
  });
});

describe('stringifyToolOutput', () => {
  it('字符串原样返回，对象格式化为多行 JSON', () => {
    expect(stringifyToolOutput('text')).toBe('text');
    expect(stringifyToolOutput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('循环引用不会抛错', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stringifyToolOutput(cyclic)).not.toThrow();
  });
});

describe('formatToolOutput', () => {
  it('超过上限的结果被截断', () => {
    const long = 'x'.repeat(TOOL_OUTPUT_LIMIT + 500);
    const formatted = formatToolOutput(long);
    expect(formatted.length).toBeLessThan(long.length);
    expect(formatted).toContain('已省略');
  });

  it('对象结果保持可读的 JSON', () => {
    expect(formatToolOutput({ ok: true })).toContain('"ok": true');
  });
});
