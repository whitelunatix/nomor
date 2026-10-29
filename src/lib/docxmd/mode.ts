/**
 * `.docx.md` 模式判定。
 *
 * 文件名后缀是最可靠的信号；重命名或粘贴内容才用内容评分兜底。
 * 只影响编辑器表现，不改变文件类型。
 */
import { parseDirectiveContent } from './directiveGrammar';

export function isDocxMarkdownPath(path: string | null | undefined): boolean {
  if (!path) return false;
  return /\.docx\.md$/i.test(path.trim());
}

const STRONG_SIGNAL = /^\s*<!--\s*(?:global\.[A-Za-z]|var\s+[A-Za-z_]\w*\s*=|fun\s+[A-Za-z_]\w*\s*\(|use\s+[A-Za-z_]|@table\.|@image\.|@toc\.)/;
const INLINE_MARKER = /\[\[(?:TBL|FIG|EQ|REF|PARA|NEW|CMT|BR|TAB|SLOT|FN|EN|INS|DEL)\b/;

/** 内容评分仅在文件名无法判断时使用。 */
export function detectDocxMarkdownContent(markdown: string): boolean {
  if (!markdown) return false;
  const lines = markdown.split(/\r?\n/);
  let strong = 0;
  let medium = 0;
  let markers = 0;
  for (const line of lines) {
    if (STRONG_SIGNAL.test(line)) {
      strong += 1;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
      const inner = trimmed.slice(4, -3);
      if (parseDirectiveContent(inner)) medium += 1;
      continue;
    }
    if (INLINE_MARKER.test(line)) markers += 1;
  }
  if (strong > 0) return true;
  return medium >= 3 || (medium >= 1 && markers >= 2) || markers >= 4;
}

export interface DocxModeInput {
  path?: string | null;
  markdown?: string;
  /** 已锁定的标签页模式；避免编辑中删除指令导致模式闪烁。 */
  locked?: boolean;
}

export function resolveDocxMode(input: DocxModeInput): boolean {
  if (input.locked) return true;
  if (isDocxMarkdownPath(input.path)) return true;
  return input.markdown ? detectDocxMarkdownContent(input.markdown) : false;
}
