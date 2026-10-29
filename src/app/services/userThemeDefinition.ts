import {
  THEME_COLOR_TOKEN_NAMES,
  THEME_STYLE_TOKEN_NAMES,
  type ColorScheme,
  type MermaidThemeName,
  type ThemeColorTokens,
  type ThemeDefinition,
  type ThemeStyleTokens,
} from '../../lib/theme/types';
import {
  DEFAULT_COLOR_THEME_ID,
  createThemeVariant,
  themeRegistry,
  validateThemeDefinition,
} from './themeRegistry';

/**
 * 用户主题 JSON 的解析与序列化（无 IO，主窗、设置窗、启动快照和 Quick Look 共用）。
 *
 * 用户文件格式与 ThemeDefinition 相近但更宽松：颜色/样式令牌可只写需要覆盖的部分，缺省项从
 * `baseThemeId` 指定的内置主题同一明暗变体补齐；预览色和 Mermaid `base` 变量总是由合并后的
 * 令牌派生，不信任文件中的同名字段。
 */

/** 与 Rust 侧 `validate_user_theme_id` 一致；`user-` 前缀保证不与内置主题冲突。 */
const USER_THEME_ID_PATTERN = /^user-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_USER_THEME_ID_LENGTH = 64;
/** 元数据字段长度上限，只用于拦截异常文件，正常名称远小于此。 */
const MAX_METADATA_LENGTH = 80;
const MAX_LOCALIZED_NAMES = 16;
const COLOR_SCHEMES: ColorScheme[] = ['light', 'dark'];
const TEMPLATE_NAME_SUFFIX: Record<string, string> = {
  'zh-CN': '（自定义）',
  'zh-TW': '（自訂）',
  'en-US': ' Custom',
};

type JsonRecord = Record<string, unknown>;

export function isUserThemeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_USER_THEME_ID_LENGTH &&
    USER_THEME_ID_PATTERN.test(value)
  );
}

/**
 * 把已 `JSON.parse` 的用户主题转换为可注册的完整主题定义。
 *
 * @param raw 任意 JSON 值，不会被修改或持有。
 * @returns 令牌完整、已通过注册表校验的主题定义。
 * @throws Error 结构不符、ID 非法、含未知令牌或令牌值不安全时抛出，消息说明具体字段。
 */
export function parseUserTheme(raw: unknown): ThemeDefinition {
  const source = requireRecord(raw, '主题');
  if (source.schemaVersion !== 1) {
    throw new Error('schemaVersion 必须为 1');
  }
  if (!isUserThemeId(source.id)) {
    throw new Error('id 必须以 user- 开头，只含小写字母、数字和单个连字符，且不超过 64 字符');
  }
  const baseThemeId = optionalString(source.baseThemeId, 'baseThemeId') ?? DEFAULT_COLOR_THEME_ID;
  const base = themeRegistry.isBuiltinTheme(baseThemeId)
    ? themeRegistry.getTheme(baseThemeId)
    : undefined;
  if (!base) {
    throw new Error(`baseThemeId 必须是内置主题：${baseThemeId}`);
  }

  const variantsSource =
    source.variants === undefined ? {} : requireRecord(source.variants, 'variants');
  for (const key of Object.keys(variantsSource)) {
    if (key !== 'light' && key !== 'dark') throw new Error(`未知变体：variants.${key}`);
  }

  const theme: ThemeDefinition = {
    schemaVersion: 1,
    id: source.id,
    version: optionalString(source.version, 'version') ?? '1.0.0',
    author: optionalString(source.author, 'author') ?? 'User',
    localizedNames: parseLocalizedNames(source.localizedNames),
    styleProfile: (optionalString(source.styleProfile, 'styleProfile') ??
      base.styleProfile) as ThemeDefinition['styleProfile'],
    variants: {
      light: parseVariant(variantsSource.light, base, 'light'),
      dark: parseVariant(variantsSource.dark, base, 'dark'),
    },
  };
  validateThemeDefinition(theme);
  return theme;
}

/**
 * 把主题序列化为可编辑、可再次导入的完整 JSON（全部令牌显式列出）。
 *
 * 内置主题导出时换成 `user-<名称>-custom` ID 并在名称后加“自定义”后缀；用户主题保持原 ID，
 * 以便修改后重新导入覆盖。
 *
 * @param pretty `true` 时缩进两格，供用户编辑；启动快照使用紧凑格式。
 */
export function serializeUserTheme(theme: ThemeDefinition, pretty = true) {
  const builtin = themeRegistry.isBuiltinTheme(theme.id);
  const localizedNames = builtin
    ? Object.fromEntries(
        Object.entries(theme.localizedNames).map(([locale, name]) => [
          locale,
          `${name}${TEMPLATE_NAME_SUFFIX[locale] ?? ' Custom'}`,
        ]),
      )
    : theme.localizedNames;
  const template = {
    schemaVersion: 1,
    id: builtin ? `user-${theme.id.replace(/^nomo-/, '')}-custom` : theme.id,
    version: theme.version,
    author: builtin ? 'User' : theme.author,
    localizedNames,
    ...(builtin ? { baseThemeId: theme.id } : {}),
    styleProfile: theme.styleProfile,
    variants: Object.fromEntries(
      COLOR_SCHEMES.map((scheme) => {
        const variant = theme.variants[scheme];
        return [
          scheme,
          {
            tokens: variant.tokens,
            styleTokens: variant.styleTokens,
            shikiTheme: variant.shikiTheme,
            mermaid: { theme: variant.mermaid.theme },
          },
        ];
      }),
    ),
  };
  return pretty ? `${JSON.stringify(template, null, 2)}\n` : JSON.stringify(template);
}

/** 解析并注册（同 ID 覆盖）用户主题源文；供启动快照与 Quick Look 在无 IPC 时恢复主题。 */
export function registerUserThemeSource(source: string) {
  const theme = parseUserTheme(JSON.parse(source));
  themeRegistry.registerTheme(theme, { replace: true });
  return theme;
}

function parseVariant(
  raw: unknown,
  base: ThemeDefinition,
  scheme: ColorScheme,
): ThemeDefinition['variants'][ColorScheme] {
  const path = `variants.${scheme}`;
  const source = raw === undefined ? {} : requireRecord(raw, path);
  const baseVariant = base.variants[scheme];
  const tokens = mergeTokens<ThemeColorTokens>(
    baseVariant.tokens,
    source.tokens,
    THEME_COLOR_TOKEN_NAMES,
    `${path}.tokens`,
  );
  const styleTokens = mergeTokens<ThemeStyleTokens>(
    baseVariant.styleTokens,
    source.styleTokens,
    THEME_STYLE_TOKEN_NAMES,
    `${path}.styleTokens`,
  );
  const shikiTheme =
    optionalString(source.shikiTheme, `${path}.shikiTheme`) ?? baseVariant.shikiTheme;
  const mermaidSource =
    source.mermaid === undefined ? {} : requireRecord(source.mermaid, `${path}.mermaid`);
  const mermaidTheme = (optionalString(mermaidSource.theme, `${path}.mermaid.theme`) ??
    baseVariant.mermaid.theme) as MermaidThemeName;
  return createThemeVariant(tokens, styleTokens, shikiTheme, mermaidTheme);
}

function mergeTokens<T extends Record<string, string>>(
  base: T,
  raw: unknown,
  names: readonly string[],
  path: string,
): T {
  if (raw === undefined) return { ...base };
  const source = requireRecord(raw, path);
  const allowed = new Set(names);
  const merged: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(source)) {
    if (!allowed.has(name)) throw new Error(`未知令牌：${path}.${name}`);
    if (typeof value !== 'string') throw new Error(`令牌必须是字符串：${path}.${name}`);
    merged[name] = value.trim();
  }
  return merged as T;
}

function parseLocalizedNames(raw: unknown) {
  const source = requireRecord(raw, 'localizedNames');
  const entries = Object.entries(source);
  if (entries.length === 0 || entries.length > MAX_LOCALIZED_NAMES) {
    throw new Error(`localizedNames 需要 1-${MAX_LOCALIZED_NAMES} 个名称`);
  }
  const names: Record<string, string> = {};
  for (const [locale, value] of entries) {
    const name = optionalString(value, `localizedNames.${locale}`);
    if (!name || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      throw new Error(`localizedNames.${locale} 无效`);
    }
    names[locale] = name;
  }
  return names;
}

function optionalString(value: unknown, path: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_METADATA_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${path} 为空、过长或含控制字符`);
  }
  return trimmed;
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象`);
  }
  return value as JsonRecord;
}
