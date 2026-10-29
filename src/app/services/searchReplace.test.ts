import { describe, expect, it } from 'vitest';
import { findTextMatches, replaceAllTextMatches, replaceTextRange } from './searchReplace';

describe('searchReplace', () => {
  it('finds literal matches without case sensitivity by default', () => {
    const matches = findTextMatches('Alpha alpha ALPHA', 'alpha', { caseSensitive: false });

    expect(matches.map((match) => [match.from, match.to, match.text])).toEqual([
      [0, 5, 'Alpha'],
      [6, 11, 'alpha'],
      [12, 17, 'ALPHA'],
    ]);
  });

  it('respects case sensitive matching', () => {
    const matches = findTextMatches('Alpha alpha ALPHA', 'alpha', { caseSensitive: true });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.from).toBe(6);
  });

  it('replaces one selected match', () => {
    const [match] = findTextMatches('one two one', 'two', { caseSensitive: false });

    expect(replaceTextRange('one two one', match!, 'three')).toBe('one three one');
  });

  it('replaces all matches from the end to preserve offsets', () => {
    const result = replaceAllTextMatches('alpha alpha', 'alpha', 'a', { caseSensitive: false });

    expect(result).toEqual({ text: 'a a', count: 2 });
  });
});
