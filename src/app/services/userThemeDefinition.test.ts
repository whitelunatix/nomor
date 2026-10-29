import { afterEach, describe, expect, it } from 'vitest';
import { themeRegistry } from './themeRegistry';
import { isUserThemeId, parseUserTheme, serializeUserTheme } from './userThemeDefinition';

const minimal = {
  schemaVersion: 1,
  id: 'user-ocean',
  localizedNames: { 'zh-CN': '海洋', 'en-US': 'Ocean' },
  baseThemeId: 'nomo-github',
  variants: {
    light: { tokens: { accent: '#0077b6' }, styleTokens: { radiusMd: '10px' } },
    dark: { tokens: { accent: '#48cae4' }, mermaid: { theme: 'base' } },
  },
};

afterEach(() => {
  themeRegistry.unregisterTheme('user-ocean');
  themeRegistry.unregisterTheme('user-github-custom');
});

describe('user theme definition', () => {
  it('fills omitted tokens from the base theme and derives preview and mermaid colors', () => {
    const base = themeRegistry.getTheme('nomo-github')!;
    const theme = parseUserTheme(minimal);

    expect(theme.author).toBe('User');
    expect(theme.styleProfile).toBe(base.styleProfile);
    expect(theme.variants.light.tokens.accent).toBe('#0077b6');
    expect(theme.variants.light.tokens.foreground).toBe(base.variants.light.tokens.foreground);
    expect(theme.variants.light.styleTokens.radiusMd).toBe('10px');
    expect(theme.variants.light.preview.accent).toBe('#0077b6');
    expect(theme.variants.light.shikiTheme).toBe(base.variants.light.shikiTheme);
    expect(theme.variants.dark.mermaid.themeVariables?.nodeBorder).toBe('#48cae4');
  });

  it('rejects ids, tokens and values that could collide or escape CSS', () => {
    const variants = (light: object) => ({ ...minimal, variants: { light } });
    expect(() => parseUserTheme({ ...minimal, id: 'nomo-default' })).toThrow(/user-/);
    expect(() => parseUserTheme({ ...minimal, baseThemeId: 'user-other' })).toThrow(/baseThemeId/);
    expect(() => parseUserTheme(variants({ tokens: { acent: '#fff' } }))).toThrow(/未知令牌/);
    expect(() => parseUserTheme(variants({ tokens: { accent: 'red; color: blue' } }))).toThrow(
      /令牌值非法/,
    );
    expect(() => parseUserTheme(variants({ tokens: { accent: 'url(x)' } }))).toThrow(/令牌值非法/);
    expect(() => parseUserTheme(variants({ styleTokens: { radiusMd: 'calc(1px)' } }))).toThrow(
      /令牌值非法/,
    );
    expect(() => parseUserTheme(variants({ shikiTheme: 'dracula' }))).toThrow(/Shiki/);
    expect(() => parseUserTheme({ ...minimal, localizedNames: {} })).toThrow(/localizedNames/);
    expect(() => parseUserTheme([])).toThrow(/对象/);
    expect(isUserThemeId('user-a-1')).toBe(true);
    expect(isUserThemeId('user-')).toBe(false);
  });

  it('exports built-in themes as importable user templates and round-trips user themes', () => {
    const template = JSON.parse(serializeUserTheme(themeRegistry.getTheme('nomo-github')!));
    expect(template.id).toBe('user-github-custom');
    expect(template.baseThemeId).toBe('nomo-github');
    expect(template.localizedNames['zh-CN']).toMatch(/自定义/);
    const fromTemplate = parseUserTheme(template);
    expect(fromTemplate.variants.dark.tokens).toEqual(
      themeRegistry.getTheme('nomo-github')!.variants.dark.tokens,
    );

    const theme = parseUserTheme(minimal);
    expect(parseUserTheme(JSON.parse(serializeUserTheme(theme, false)))).toEqual(theme);
  });

  it('never lets user themes replace or unregister built-in themes', () => {
    const builtin = themeRegistry.getTheme('nomo-default')!;
    expect(() => themeRegistry.registerTheme(builtin, { replace: true })).toThrow(/重复/);
    expect(themeRegistry.unregisterTheme('nomo-default')).toBe(false);

    const theme = parseUserTheme(minimal);
    themeRegistry.registerTheme(theme, { replace: true });
    themeRegistry.registerTheme(theme, { replace: true });
    expect(themeRegistry.isBuiltinTheme('user-ocean')).toBe(false);
    expect(themeRegistry.unregisterTheme('user-ocean')).toBe(true);
  });
});
