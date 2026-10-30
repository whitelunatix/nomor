import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from './html';

describe('sanitizeHtml', () => {
  it('keeps a normalized text color on spans', () => {
    expect(sanitizeHtml('<span style="color: #e11d48">红</span>')).toBe(
      '<span style="color: #e11d48">红</span>',
    );
  });

  it('drops every other style declaration', () => {
    expect(
      sanitizeHtml('<span style="font-weight: bold; color: rgb(1, 2, 3); background: url(x)">红</span>'),
    ).toBe('<span style="color: rgb(1, 2, 3)">红</span>');
    expect(sanitizeHtml('<span style="background: url(x)">红</span>')).toBe('<span>红</span>');
  });

  it('removes scripts and non-color styles from other tags', () => {
    expect(sanitizeHtml('<span onclick="alert(1)" style="color: #16a34a">红</span>')).toBe(
      '<span style="color: #16a34a">红</span>',
    );
    expect(sanitizeHtml('<div style="color: red">红</div>')).toBe('<div>红</div>');
    expect(sanitizeHtml('<script>alert(1)</script>')).not.toContain('<script');
  });
});
