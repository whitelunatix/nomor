import { describe, expect, it } from 'vitest';
import {
  EMPTY_FONT_PREFERENCES,
  applyFontPreferences,
  isValidFontFamilyInput,
  normalizeFontFamilyName,
} from './fonts';
import type { ThemeStyleTokens } from './types';

const styleTokens = {
  fontUi: "'Segoe UI', sans-serif",
  fontDocument: "'Segoe UI', sans-serif",
  fontMono: 'Consolas, monospace',
} as ThemeStyleTokens;

describe('theme font overrides', () => {
  it('normalizes a single family name and rejects CSS-breaking input', () => {
    expect(normalizeFontFamilyName('  LXGW   WenKai ')).toBe('LXGW WenKai');
    expect(normalizeFontFamilyName('霞鹜文楷')).toBe('霞鹜文楷');
    for (const value of [
      'A", B',
      'A;color:red',
      'url(x)',
      'A !important',
      "A'",
      'A,B',
      'x'.repeat(101),
      42,
    ]) {
      expect(normalizeFontFamilyName(value)).toBe('');
    }
    expect(isValidFontFamilyInput('   ')).toBe(true);
    expect(isValidFontFamilyInput('A, B')).toBe(false);
  });

  it('prepends overrides and keeps the theme stack as fallback', () => {
    expect(applyFontPreferences(styleTokens, EMPTY_FONT_PREFERENCES)).toBe(styleTokens);
    const next = applyFontPreferences(styleTokens, {
      uiFontFamily: '',
      documentFontFamily: 'LXGW WenKai',
      monoFontFamily: 'Monospace',
    });
    expect(next.fontUi).toBe(styleTokens.fontUi);
    expect(next.fontDocument).toBe(`"LXGW WenKai", 'Segoe UI', sans-serif`);
    // 通用族关键字加引号会变成同名具体字体，必须原样输出。
    expect(next.fontMono).toBe('monospace, Consolas, monospace');
    expect(styleTokens.fontDocument).toBe("'Segoe UI', sans-serif");
  });
});
