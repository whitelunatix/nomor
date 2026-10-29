/**
 * `.docx.md` 的 Python 校验侧车（`bin/docxmd_validate.exe`）客户端。
 *
 * 桌面端以 Python 的 `verify_forward` 为唯一校验真源：Rust 常驻一个 JSON-lines
 * 子进程，前端只读地传入 Markdown 文本。浏览器预览没有该进程，返回 `null`，
 * 调用方继续使用 TypeScript 的即时结果。
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '../desktop/tauriStorage';
import type { DocxDiagnostic } from './model';
import type { DocxValidationSummary } from './validate';

interface PythonDiagnosticPayload {
  severity?: string;
  code?: string;
  message?: string;
  line?: number | null;
  column?: number | null;
  field?: string | null;
}

export interface PythonValidationPayload {
  ok?: boolean;
  error?: string;
  directiveCount?: number;
  errorCount?: number;
  warningCount?: number;
  infoCount?: number;
  diagnostics?: PythonDiagnosticPayload[];
}

export function isPythonValidatorAvailable(): boolean {
  return isTauriRuntime();
}

function normalizeSeverity(value: string | undefined): DocxDiagnostic['severity'] {
  return value === 'error' || value === 'warning' ? value : 'info';
}

/** Python 侧代码形如 E002/W101；补上编辑器统一的 `DOCX_` 前缀。 */
function normalizeCode(value: string | undefined): DocxDiagnostic['code'] {
  const code = (value ?? 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `DOCX_${code}`;
}

export function mapPythonValidationPayload(
  payload: PythonValidationPayload,
): DocxValidationSummary | null {
  if (payload?.ok !== true) return null;
  const diagnostics = (payload.diagnostics ?? []).map((item): DocxDiagnostic => ({
    code: normalizeCode(item.code),
    severity: normalizeSeverity(item.severity),
    message: item.message ?? '',
    sourceLine: item.line ?? undefined,
    ...(item.field ? { field: item.field } : {}),
  }));
  return {
    diagnostics,
    errorCount:
      payload.errorCount ?? diagnostics.filter((item) => item.severity === 'error').length,
    warningCount:
      payload.warningCount ?? diagnostics.filter((item) => item.severity === 'warning').length,
    directiveCount: payload.directiveCount ?? 0,
  };
}

/**
 * 调用 Python 校验进程；任何失败都返回 `null`，由调用方保留 TypeScript 结果。
 * 侧车进程由 Rust 复用，冷启动等待发生在阻塞线程，不阻塞前端。
 */
export async function validateDocxMarkdownWithPython(
  markdown: string,
  sourcePath: string | null,
): Promise<DocxValidationSummary | null> {
  if (!isTauriRuntime()) return null;
  try {
    const payload = await invoke<PythonValidationPayload>('docx_validate_markdown', {
      markdown,
      sourcePath: sourcePath ?? null,
    });
    return mapPythonValidationPayload(payload);
  } catch {
    return null;
  }
}
