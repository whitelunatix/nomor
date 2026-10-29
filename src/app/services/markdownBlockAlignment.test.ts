import { describe, expect, it } from 'vitest';
import {
  calculateBlockAlignmentGaps,
  createBlockAlignmentAnchors,
  type BlockNaturalGeometry,
} from './markdownBlockAlignment';

describe('markdownBlockAlignment', () => {
  it('adds the height difference after the shorter source block', () => {
    const result = calculateBlockAlignmentGaps(
      [geometry('node:0', 0, 80), geometry('node:1', 80, 140)],
      [geometry('node:0', 0, 100), geometry('node:1', 100, 160)],
      3,
    );

    expect(result).toEqual({
      status: 'ready',
      generation: 3,
      gaps: [
        { key: 'node:0', sourceGap: 20, semanticGap: 0 },
        { key: 'node:1', sourceGap: 0, semanticGap: 0 },
      ],
    });
  });

  it('compares natural advances after subtracting the previous virtual gap', () => {
    const result = calculateBlockAlignmentGaps(
      [geometry('node:0', 0, 120, 20), geometry('node:1', 120, 190, 10)],
      [geometry('node:0', 0, 100), geometry('node:1', 100, 180)],
      4,
    );

    expect(result.status).toBe('ready');
    expect(result.gaps).toEqual([
      { key: 'node:0', sourceGap: 0, semanticGap: 0 },
      { key: 'node:1', sourceGap: 20, semanticGap: 0 },
    ]);
  });

  it('puts the gap on the semantic side when source wrapping is taller', () => {
    const result = calculateBlockAlignmentGaps(
      [geometry('node:0', 0, 135)],
      [geometry('node:0', 0, 90)],
      5,
    );

    expect(result.gaps).toEqual([{ key: 'node:0', sourceGap: 0, semanticGap: 45 }]);
  });

  it('treats differences within one pixel as equal', () => {
    const result = calculateBlockAlignmentGaps(
      [geometry('node:0', 0, 100.4)],
      [geometry('node:0', 0, 101.2)],
      6,
    );

    expect(result.gaps).toEqual([{ key: 'node:0', sourceGap: 0, semanticGap: 0 }]);
  });

  it('falls back when block keys or counts do not match', () => {
    expect(
      calculateBlockAlignmentGaps([geometry('node:0', 0, 80)], [geometry('node:1', 0, 80)], 7),
    ).toEqual({ status: 'fallback', generation: 7, gaps: [] });

    expect(
      calculateBlockAlignmentGaps(
        [geometry('node:0', 0, 80)],
        [geometry('node:0', 0, 80), geometry('node:1', 80, 160)],
        8,
      ).status,
    ).toBe('fallback');
  });

  it('creates front matter and trailing EOF anchors without changing mapped nodes', () => {
    const markdown = '---\ntitle: Demo\n---\n# Title\n\nBody\n';
    const anchors = createBlockAlignmentAnchors(markdown, 3);

    expect(anchors).toEqual([
      { key: 'front-matter', nodeIndex: -1, fromLine: 1, toLine: 3 },
      { key: 'node:0', nodeIndex: 0, fromLine: 4, toLine: 4 },
      { key: 'node:1', nodeIndex: 1, fromLine: 6, toLine: 6 },
      { key: 'eof', nodeIndex: 2, fromLine: 7, toLine: 7 },
    ]);
  });
});

function geometry(
  key: string,
  top: number,
  nextTop: number,
  existingGap = 0,
): BlockNaturalGeometry {
  return { key, top, nextTop, existingGap };
}
