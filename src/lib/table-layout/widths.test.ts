import { describe, expect, it } from 'vitest';
import { allocateTableWidths, tableConstraints, type CellMetrics } from './widths';
import { domTableGrid } from './export';

const cell = (column: number, natural: number, extra: Partial<CellMetrics> = {}): CellMetrics => ({
  column,
  natural,
  span: 1,
  header: false,
  atomic: 0,
  chrome: 23,
  ...extra,
});
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('content-driven table widths', () => {
  it('keeps a short table compact and gives longer fields more width', () => {
    const constraints = tableConstraints(3, [cell(0, 28), cell(1, 140), cell(2, 250)], 14);
    const result = allocateTableWidths(constraints, 900);
    expect(result.width).toBeLessThan(900);
    expect(result.columns[0]).toBeLessThan(result.columns[1]);
    expect(result.columns[1]).toBeLessThan(result.columns[2]);
  });
  it('compresses elastic columns while preserving the readable minima', () => {
    const constraints = tableConstraints(
      4,
      [cell(0, 98), cell(1, 500), cell(2, 210), cell(3, 550)],
      14,
    );
    const result = allocateTableWidths(constraints, 700);
    expect(result.width).toBe(700);
    expect(result.columns[0]).toBeLessThan(result.columns[1]);
    result.columns.forEach((width, i) =>
      expect(width).toBeGreaterThanOrEqual(constraints[i].minimum - 0.01),
    );
    expect(total(result.columns)).toBeCloseTo(result.width, 6);
  });
  it('scrolls rather than squeezing below the minimum', () => {
    const constraints = tableConstraints(
      8,
      Array.from({ length: 8 }, (_, i) => cell(i, 300)),
      14,
    );
    const result = allocateTableWidths(constraints, 380);
    expect(result.overflow).toBe(true);
    expect(result.width).toBeGreaterThan(380);
    expect(result.columns[0]).toBe(107);
  });
  it('does not let one very long outlier dominate a short-field column', () => {
    const short = [...Array.from({ length: 19 }, () => cell(0, 40)), cell(0, 10000)];
    const constraints = tableConstraints(2, [...short, cell(1, 350)], 14);
    expect(constraints[0].preferred).toBe(12 * 14 + 23);
    expect(constraints[0].preferred).toBeLessThan(constraints[1].preferred);
  });
  it('uses nearest-rank p90 for small samples and caps headers separately', () => {
    const constraints = tableConstraints(
      2,
      [cell(0, 200), cell(0, 300), cell(1, 900, { header: true })],
      14,
    );
    expect(constraints[0].preferred).toBe(323);
    expect(constraints[1].preferred).toBe(191);
  });
  it('ignores empty bodies in the percentile and gives empty columns a baseline', () => {
    const constraints = tableConstraints(
      2,
      [...Array.from({ length: 20 }, () => cell(0, 0)), cell(0, 300), cell(1, 0)],
      14,
    );
    expect(constraints[0].preferred).toBe(323);
    expect(constraints[1].minimum).toBe(65);
  });
  it('preserves a header wider than its body when another column needs more space', () => {
    const constraints = tableConstraints(
      2,
      [cell(0, 140, { header: true }), cell(0, 28), cell(1, 500)],
      14,
    );
    const result = allocateTableWidths(constraints, 320);
    expect(result.columns[0]).toBe(163);
    expect(result.width).toBe(320);
    expect(result.overflow).toBe(false);
    expect(allocateTableWidths(constraints, 240).overflow).toBe(true);
  });
  it('protects merged headers during compression and still bounds very long headers', () => {
    const constraints = tableConstraints(
      3,
      [cell(0, 280, { header: true, span: 2 }), cell(0, 28), cell(1, 28), cell(2, 500)],
      14,
    );
    const result = allocateTableWidths(constraints, 430);
    expect(result.columns[0] + result.columns[1]).toBeGreaterThanOrEqual(303);
    expect(result.width).toBe(430);
    const longHeader = tableConstraints(1, [cell(0, 900, { header: true })], 14);
    expect(allocateTableWidths(longHeader, 300).columns).toEqual([191]);
  });
  it('respects atomic objects and authored widths without modifying their data', () => {
    const explicit = [250, 0];
    const constraints = tableConstraints(
      2,
      [cell(0, 30, { span: 2, explicit }), cell(1, 500, { atomic: 500 })],
      14,
    );
    expect(constraints[0].minimum).toBeGreaterThanOrEqual(250);
    expect(constraints[1].minimum).toBeGreaterThanOrEqual(523);
    expect(explicit).toEqual([250, 0]);
    expect(allocateTableWidths(constraints, 300).overflow).toBe(true);
  });
  it('satisfies overlapping colspan constraints without assigning everything to column zero', () => {
    const constraints = tableConstraints(
      3,
      [
        cell(0, 100),
        cell(1, 200),
        cell(2, 300),
        cell(0, 900, { span: 2, atomic: 450 }),
        cell(1, 1100, { span: 2, atomic: 600 }),
      ],
      14,
    );
    expect(constraints[0].minimum + constraints[1].minimum).toBeGreaterThanOrEqual(473);
    expect(constraints[1].minimum + constraints[2].minimum).toBeGreaterThanOrEqual(623);
    expect(constraints[1].preferred).toBeGreaterThan(constraints[0].preferred);
  });
  it('is deterministic across resize cycles including fractional widths and one column', () => {
    const constraints = tableConstraints(3, [cell(0, 107.13), cell(1, 333.7), cell(2, 295.77)], 14);
    const original = allocateTableWidths(constraints, 555.55);
    allocateTableWidths(constraints, 200);
    expect(allocateTableWidths(constraints, 555.55)).toEqual(original);
    expect(total(original.columns)).toBeCloseTo(original.width, 6);
    expect(allocateTableWidths(tableConstraints(1, [cell(0, 300)], 14), 500).columns).toEqual([
      323,
    ]);
  });
  it('maps rowspans to logical columns and counts each physical cell once', () => {
    const table = document.createElement('table');
    table.innerHTML =
      '<tbody><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><td>C</td><td>D</td></tr></tbody>';
    const grid = domTableGrid(table);
    expect(grid.columns).toBe(3);
    expect(grid.cells.map((cell) => [cell.column, cell.span])).toEqual([
      [0, 1],
      [1, 2],
      [1, 1],
      [2, 1],
    ]);
  });
});
