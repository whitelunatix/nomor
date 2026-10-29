import { describe, expect, it } from 'vitest';
import { bareLinkHrefForText, matchBareLinkAt } from './bareLinks';

describe('bareLinks', () => {
  it('recognizes http(s) and www URLs with their normalized href', () => {
    expect(matchBareLinkAt('https://example.com/a_b', 0)).toEqual({
      text: 'https://example.com/a_b',
      href: 'https://example.com/a_b',
      end: 23,
    });
    expect(matchBareLinkAt('www.example.com', 0)).toEqual({
      text: 'www.example.com',
      href: 'http://www.example.com',
      end: 15,
    });
  });

  it('recognizes email addresses as mailto links', () => {
    expect(matchBareLinkAt('a.b+tag@example.co.uk', 0)).toEqual({
      text: 'a.b+tag@example.co.uk',
      href: 'mailto:a.b+tag@example.co.uk',
      end: 21,
    });
  });

  it('trims sentence punctuation and unbalanced closing parentheses', () => {
    expect(matchBareLinkAt('https://example.com/a.', 0)?.text).toBe('https://example.com/a');
    expect(matchBareLinkAt('https://example.com/a,', 0)?.text).toBe('https://example.com/a');
    expect(matchBareLinkAt('https://example.com/x)', 0)?.text).toBe('https://example.com/x');
    expect(matchBareLinkAt('https://example.com/wiki/Foo_(bar)', 0)?.text).toBe(
      'https://example.com/wiki/Foo_(bar)',
    );
  });

  it('requires a bare link to start at a word boundary', () => {
    expect(matchBareLinkAt('xhttps://example.com', 1)).toBeNull();
    expect(matchBareLinkAt('见https://example.com', 1)?.href).toBe('https://example.com');
  });

  it('rejects malformed or unsupported addresses', () => {
    expect(matchBareLinkAt('https://', 0)).toBeNull();
    expect(matchBareLinkAt('www.', 0)).toBeNull();
    expect(matchBareLinkAt('ftp://example.com', 0)).toBeNull();
    expect(matchBareLinkAt('a@b', 0)).toBeNull();
  });

  it('only reports a href when the whole text is a bare link', () => {
    expect(bareLinkHrefForText('www.example.com')).toBe('http://www.example.com');
    expect(bareLinkHrefForText('见 www.example.com')).toBeNull();
    expect(bareLinkHrefForText('https://example.com/a.')).toBeNull();
  });
});
