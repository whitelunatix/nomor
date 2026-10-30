import { describe, expect, it } from 'vitest';
import {
  normalizeTextColor,
  parseTextColorOpenTag,
  readTextColorFromStyle,
  textColorOpenTag,
  textColorFromHtmlTag,
  textColorToHex,
} from './textColor';

describe('text color values', () => {
  it.each(['#e11d48', '#ABC', '#abcd', '#11223344', 'rgb(1, 2, 3)', 'rgba(1, 2, 3, .5)', 'hsl(10 20% 30%)'])(
    'accepts safe color %s',
    (value) => {
      expect(normalizeTextColor(value)).not.toBeNull();
    },
  );

  it.each([
    'red; background: url(x)',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '#12345',
    'var(--color)',
    '',
    null,
    undefined,
  ])('rejects unsafe color %s', (value) => {
    expect(normalizeTextColor(value)).toBeNull();
  });

  it('reads only the color declaration from inline styles', () => {
    expect(readTextColorFromStyle('font-weight: bold; color: #e11d48')).toBe('#e11d48');
    expect(readTextColorFromStyle('background: #ffffff')).toBeNull();
    expect(readTextColorFromStyle(null)).toBeNull();
  });

  it('converts colors to the six-digit hex used by Word', () => {
    expect(textColorToHex('#e11d48')).toBe('E11D48');
    expect(textColorToHex('#abc')).toBe('AABBCC');
    expect(textColorToHex('#11223344')).toBe('112233');
    expect(textColorToHex('rgb(1, 2, 3)')).toBe('010203');
    expect(textColorToHex('rgb(300, 0, 0)')).toBe('FF0000');
    expect(textColorToHex('hsl(10 20% 30%)')).toBeNull();
    expect(textColorToHex('not-a-color')).toBeNull();
  });

  it('parses open tags and close tags exactly', () => {
    expect(parseTextColorOpenTag('<span style="color: #e11d48">')).toBe('#e11d48');
    expect(parseTextColorOpenTag("<span style='color: #2563eb'>")).toBe('#2563eb');
    expect(parseTextColorOpenTag('<span>')).toBeNull();
    expect(parseTextColorOpenTag('<span style="font-weight: bold">')).toBeNull();
    expect(textColorFromHtmlTag('</span>')).toEqual({ color: '', closing: true });
    expect(textColorOpenTag('#16a34a')).toBe('<span style="color: #16a34a">');
  });
});
