import type { FontPreferences, ThemeStyleTokens } from './types';

export const FONT_PREFERENCE_KEYS = [
  'uiFontFamily',
  'documentFontFamily',
  'monoFontFamily',
] as const satisfies readonly (keyof FontPreferences)[];

export const EMPTY_FONT_PREFERENCES: Readonly<FontPreferences> = Object.freeze({
  uiFontFamily: '',
  documentFontFamily: '',
  monoFontFamily: '',
});

const FONT_STYLE_TOKENS: Record<keyof FontPreferences, keyof ThemeStyleTokens> = {
  uiFontFamily: 'fontUi',
  documentFontFamily: 'fontDocument',
  monoFontFamily: 'fontMono',
};

/** 系统字体族名通常不超过 60 字符；上限只用于拦截异常配置值。 */
const MAX_FONT_FAMILY_LENGTH = 100;
/**
 * 字体名会拼进 CSS `font-family` 双引号串并写入根节点变量：拒绝引号、反斜杠、
 * 声明分隔符、括号（`url(`）、`!`（`!important`）、逗号（多字体栈）和控制字符。
 */
const UNSAFE_FONT_FAMILY_PATTERN = /["'\\;:{}()<>,!\u0000-\u001f\u007f]/;
/** CSS 通用字体族关键字；加引号后会变成同名具体字体，必须原样输出。 */
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
]);

/**
 * 把用户输入归一化为单个安全的字体族名。
 *
 * @param value 任意来源的原始值（配置文件、设置输入）。
 * @returns 去除首尾空白并折叠内部空白后的名称；空值、非字符串或含非法字符时返回 `''`（跟随主题）。
 */
export function normalizeFontFamilyName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_FONT_FAMILY_LENGTH || UNSAFE_FONT_FAMILY_PATTERN.test(name)) {
    return '';
  }
  return name;
}

/** 输入是否可作为字体覆盖保存；空白输入视为合法的“跟随主题”。 */
export function isValidFontFamilyInput(value: string) {
  return value.trim() === '' || normalizeFontFamilyName(value) !== '';
}

export function normalizeFontPreferences(
  value: Partial<Record<keyof FontPreferences, unknown>> | null | undefined,
): FontPreferences {
  return {
    uiFontFamily: normalizeFontFamilyName(value?.uiFontFamily),
    documentFontFamily: normalizeFontFamilyName(value?.documentFontFamily),
    monoFontFamily: normalizeFontFamilyName(value?.monoFontFamily),
  };
}

/** 生成可写入 CSS `font-family` 的单项：通用关键字原样输出，其余加双引号。 */
export function formatFontFamilyName(name: string) {
  return GENERIC_FONT_FAMILIES.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`;
}

/**
 * 把字体覆盖叠加到主题样式令牌上。
 *
 * 覆盖字体放在主题字体栈之前，主题栈整体保留为缺字和字体未安装时的回退。
 *
 * @param styleTokens 主题变体的样式令牌，不会被修改。
 * @param fonts 已归一化的字体偏好。
 * @returns 无覆盖时原样返回 `styleTokens`；否则返回新对象。
 */
export function applyFontPreferences(
  styleTokens: ThemeStyleTokens,
  fonts: FontPreferences,
): ThemeStyleTokens {
  if (FONT_PREFERENCE_KEYS.every((key) => !fonts[key])) return styleTokens;
  const next = { ...styleTokens };
  for (const key of FONT_PREFERENCE_KEYS) {
    const name = fonts[key];
    if (!name) continue;
    const token = FONT_STYLE_TOKENS[key];
    next[token] = `${formatFontFamilyName(name)}, ${styleTokens[token]}`;
  }
  return next;
}
