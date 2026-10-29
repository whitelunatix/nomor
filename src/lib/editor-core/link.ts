const DISALLOWED_LINK_PROTOCOLS = /^(?:javascript|vbscript|data)\s*:/i;
const ALLOWED_ABSOLUTE_LINK_PROTOCOLS = /^(?:https?|mailto):/i;
const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/;
const LINK_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface NormalizedLinkAttrs {
  href: string;
  title: string | null;
}

/**
 * 校验并规范化 Markdown 超链接地址。
 *
 * 超链接是 Markdown-first 的行内语义：允许 Web、邮件、锚点和相对路径，
 * 拒绝脚本协议，避免语义编辑区和 HTML 适配层出现不同的安全边界。
 */
export function normalizeLinkHref(value: unknown): string | null {
  const href = String(value ?? '').trim();
  if (!href) return null;
  // URL 解析会忽略 TAB/LF/CR；拒绝残留控制字符，避免绕过协议校验。
  if (LINK_CONTROL_CHARACTERS.test(href)) return null;
  if (DISALLOWED_LINK_PROTOCOLS.test(href)) return null;

  const protocolMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (protocolMatch) {
    if (WINDOWS_DRIVE_PATH.test(href)) return href;
    return ALLOWED_ABSOLUTE_LINK_PROTOCOLS.test(href) ? href : null;
  }

  return href;
}

export function createLinkAttrs(href: unknown, title?: unknown): NormalizedLinkAttrs | null {
  const normalizedHref = normalizeLinkHref(href);
  if (!normalizedHref) return null;

  const normalizedTitle = normalizeLinkTitle(title);
  return {
    href: normalizedHref,
    title: normalizedTitle,
  };
}

function normalizeLinkTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const title = String(value).trim();
  return title ? title : null;
}

export function canOpenLinkHref(value: unknown): boolean {
  return normalizeLinkHref(value) !== null;
}

export function serializeMarkdownLinkDestination(href: string): string {
  // 先保护字面实体，再转义配对边界；空白地址使用 CommonMark 的尖括号形式。
  const escaped = href
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/[()<>]/g, '\\$&');
  return /\s/.test(href) ? '<' + escaped + '>' : escaped;
}

export function serializeMarkdownLinkTitle(title: string): string {
  return title
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}
