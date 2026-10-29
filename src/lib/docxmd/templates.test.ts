import { describe, expect, it } from 'vitest';
import { parseDirectiveLine } from './directiveGrammar';
import { DOCX_BLOCK_TEMPLATES, DOCX_META_TEMPLATES } from './templates';

describe('docx inspector templates', () => {
  it.each([...DOCX_BLOCK_TEMPLATES, ...DOCX_META_TEMPLATES])(
    'parses $label template',
    ({ raw }) => {
      const directive = parseDirectiveLine(raw);
      expect(directive).not.toBeNull();
      expect(directive!.diagnostics.filter((item) => item.severity === 'error')).toHaveLength(0);
    },
  );

  it('keeps structural templates out of the block list', () => {
    const structural = new Set(['section', 'page', 'header', 'footer', 'toc']);
    expect(
      DOCX_BLOCK_TEMPLATES.some((item) =>
        structural.has(parseDirectiveLine(item.raw)?.canonicalKeyword ?? ''),
      ),
    ).toBe(false);
    expect(
      DOCX_META_TEMPLATES.some(
        (item) => parseDirectiveLine(item.raw)?.canonicalKeyword === 'section',
      ),
    ).toBe(true);
  });
});
