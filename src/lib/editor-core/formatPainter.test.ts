import { describe, expect, it } from 'vitest';
import { FORMAT_PAINTER_NAMES, planFormatPainter } from './formatPainter';
import type { InlinePendingMarkName } from './types';

function activeSet(...marks: InlinePendingMarkName[]) {
  const set = new Set(marks);
  return (name: InlinePendingMarkName) => set.has(name);
}

describe('planFormatPainter', () => {
  it('applies missing formats and removes extras', () => {
    const plan = planFormatPainter(
      ['strong', 'underline'],
      activeSet('strong', 'highlight'),
    );
    expect(plan.toRemove).toEqual(['highlight']);
    expect(plan.toApply).toEqual(['underline']);
  });

  it('is a no-op when the target already matches', () => {
    const plan = planFormatPainter(['strong'], activeSet('strong'));
    expect(plan.toRemove).toEqual([]);
    expect(plan.toApply).toEqual([]);
  });

  it('removes everything when copying unformatted text', () => {
    const plan = planFormatPainter([], activeSet('strong', 'em', 'code'));
    expect(plan.toRemove).toEqual(['strong', 'em', 'code']);
    expect(plan.toApply).toEqual([]);
  });

  it('removes the opposite script before applying superscript/subscript', () => {
    const sup = planFormatPainter(['superscript'], activeSet('subscript'));
    expect(sup.toRemove).toContain('subscript');
    expect(sup.toApply).toContain('superscript');

    const sub = planFormatPainter(['subscript'], activeSet('superscript'));
    expect(sub.toRemove).toContain('superscript');
    expect(sub.toApply).toContain('subscript');
  });

  it('keeps a stable order for commands to run in', () => {
    const plan = planFormatPainter(FORMAT_PAINTER_NAMES, () => false);
    expect(plan.toApply).toEqual([...FORMAT_PAINTER_NAMES]);
  });
});
