import { describe, expect, it } from 'vitest';
import { mapPythonValidationPayload } from './pythonValidator';

describe('pythonValidator', () => {
  it('maps sidecar diagnostics into the editor summary shape', () => {
    const summary = mapPythonValidationPayload({
      ok: true,
      directiveCount: 3,
      errorCount: 1,
      warningCount: 1,
      diagnostics: [
        { severity: 'error', code: 'E002', message: '未知关键字', line: 4 },
        { severity: 'warning', code: 'W101', message: '建议补充字段', line: 7, field: 'font' },
        { severity: 'info', code: 'I001', message: '已复用样式' },
      ],
    });

    expect(summary).not.toBeNull();
    expect(summary!.directiveCount).toBe(3);
    expect(summary!.errorCount).toBe(1);
    expect(summary!.warningCount).toBe(1);
    expect(summary!.diagnostics).toEqual([
      { code: 'DOCX_E002', severity: 'error', message: '未知关键字', sourceLine: 4 },
      {
        code: 'DOCX_W101',
        severity: 'warning',
        message: '建议补充字段',
        sourceLine: 7,
        field: 'font',
      },
      { code: 'DOCX_I001', severity: 'info', message: '已复用样式', sourceLine: undefined },
    ]);
  });

  it('returns null when the sidecar reports a failure so callers keep the TS result', () => {
    expect(mapPythonValidationPayload({ ok: false, error: 'bad payload' })).toBeNull();
  });

  it('derives counts from diagnostics when the sidecar omits them', () => {
    const summary = mapPythonValidationPayload({
      ok: true,
      diagnostics: [
        { severity: 'error', code: 'E001', message: 'a' },
        { severity: 'error', code: 'E001', message: 'b' },
        { severity: 'warning', code: 'W001', message: 'c' },
      ],
    });
    expect(summary!.errorCount).toBe(2);
    expect(summary!.warningCount).toBe(1);
    expect(summary!.directiveCount).toBe(0);
  });
});
