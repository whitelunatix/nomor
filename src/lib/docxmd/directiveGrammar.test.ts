import { describe, expect, it } from 'vitest';
import { parseDirectiveContent, parseDirectiveLine } from './directiveGrammar';

describe('docx directive grammar', () => {
  it('parses a block directive with fields', () => {
    const directive = parseDirectiveLine('<!-- font | mix: 宋体 10.5pt; style: norm -->');
    expect(directive).not.toBeNull();
    expect(directive!.keyword).toBe('font');
    expect(directive!.attach).toBe('block');
    expect(directive!.groups).toHaveLength(1);
    expect(directive!.groups[0]!.fields.map((field) => [field.rawName, field.rawValue])).toEqual([
      ['mix', '宋体 10.5pt'],
      ['style', 'norm'],
    ]);
  });

  it('maps global.* to the global keyword and target category', () => {
    const directive = parseDirectiveLine('<!-- global.page | size: A4; margins: top2cm bottom2cm -->');
    expect(directive).not.toBeNull();
    expect(directive!.keyword).toBe('global.page');
    expect(directive!.canonicalKeyword).toBe('global');
    expect(directive!.globalTarget).toBe('page');
    expect(directive!.category).toBe('page');
    expect(directive!.attach).toBe('meta');
    expect(directive!.groups[0]!.fields[1]!.rawValue).toBe('top2cm bottom2cm');
  });

  it('splits & groups and keeps brackets inside decorators intact', () => {
    const line =
      '<!-- list | ordered: decimal; decorators: [@list.numbering | id: auto-steps; level: 1; format: decimal; text: %1.; suffix: tab] -->';
    const directive = parseDirectiveLine(line);
    expect(directive).not.toBeNull();
    expect(directive!.groups).toHaveLength(1);
    const decoratorField = directive!.groups[0]!.fields.find((field) => field.rawName === 'decorators');
    expect(decoratorField?.rawValue).toContain('@list.numbering');
    expect(directive!.inlineDecorators).toHaveLength(1);
    expect(directive!.inlineDecorators[0]!.keyword).toBe('@list.numbering');
    expect(directive!.inlineDecorators[0]!.decorator).toBe(true);
    expect(directive!.inlineDecorators[0]!.groups[0]!.fields.map((field) => field.rawName)).toEqual([
      'id',
      'level',
      'format',
      'text',
      'suffix',
    ]);
  });

  it('parses table decorators joined with &', () => {
    const directive = parseDirectiveLine(
      '<!-- @table.header | bg: #D9E2F3; color: #000000 & font | style: bold -->',
    );
    expect(directive).not.toBeNull();
    expect(directive!.decorator).toBe(true);
    expect(directive!.attach).toBe('block');
    expect(directive!.groups.map((group) => group.rawKeyword)).toEqual(['@table.header', 'font']);
    expect(directive!.groups[1]!.fields[0]!).toMatchObject({ rawName: 'style', rawValue: 'bold' });
  });

  it('normalizes pipe-separated table scope properties', () => {
    const directive = parseDirectiveLine(
      '<!-- @table.cell | position: (1, 0) & paragraph | align: left -->',
    );
    expect(directive).not.toBeNull();
    expect(directive!.groups[0]!.fields.map((field) => field.rawName)).toEqual(['position']);
    expect(directive!.groups[1]!.fields.map((field) => field.rawName)).toEqual(['align']);
  });

  it('rejects unknown keywords so ordinary comments keep their chip', () => {
    expect(parseDirectiveLine('<!-- TODO: 普通注释 -->')).toBeNull();
    expect(parseDirectiveLine('<!-- font | style: bold')).toBeNull();
    expect(parseDirectiveContent('font | style: bold\nsecond line')).toBeNull();
  });

  it('records field spans relative to the first non-space character', () => {
    const line = '   <!-- paragraph | align: justify; indent.firstLine: 2char -->';
    const directive = parseDirectiveLine(line);
    expect(directive).not.toBeNull();
    const contentStart = directive!.contentStart;
    const align = directive!.groups[0]!.fields[0]!;
    expect(line.slice(contentStart + align.fieldSpan.from, contentStart + align.fieldSpan.to))
      .toBe('align: justify');
    expect(line.slice(contentStart + align.valueSpan.from, contentStart + align.valueSpan.to))
      .toBe('justify');
  });
});
