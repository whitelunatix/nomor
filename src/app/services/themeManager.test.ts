import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDesktopIconTheme } from './desktopWindow';
import { subscribeTypographyInteraction } from '../../lib/typography/interaction';
import {
  LEGACY_THEME_BOOT_SNAPSHOT_KEY,
  THEME_BOOT_SNAPSHOT_KEY,
  applyResolvedTheme,
  applyThemeRuntime,
  bootstrapThemeFromSnapshot,
  cancelPendingThemeEffects,
  readThemeBootSnapshot,
  resolveTheme,
  resolveThemeMode,
  writeThemeBootSnapshot,
} from './themeManager';

vi.mock('./desktopWindow', () => ({
  getDesktopSystemTheme: vi.fn().mockResolvedValue('dark'),
  setDesktopIconTheme: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
  document.documentElement.removeAttribute('data-color-theme');
  document.documentElement.removeAttribute('data-theme-style');
  document.documentElement.removeAttribute('data-document-style');
  document.documentElement.removeAttribute('data-block-style');
  cancelPendingThemeEffects();
  vi.mocked(setDesktopIconTheme).mockClear();
});

afterEach(() => {
  cancelPendingThemeEffects();
  vi.unstubAllGlobals();
});

describe('themeManager', () => {
  it('resolves system mode and explicit modes independently from the color theme', () => {
    expect(resolveThemeMode('system', 'dark')).toBe('dark');
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');

    const resolved = resolveTheme(
      {
        themeMode: 'dark',
        colorThemeId: 'nomo-amber-paper',
        documentStyleId: 'nomo-classic',
      },
      'light',
    );
    expect(resolved.effectiveScheme).toBe('dark');
    expect(resolved.preferences.colorThemeId).toBe('nomo-amber-paper');
  });

  it('applies explicit root attributes and every required color token', () => {
    const resolved = resolveTheme(
      {
        themeMode: 'light',
        colorThemeId: 'nomo-amber-paper',
        documentStyleId: 'nomo-classic',
      },
      'dark',
    );
    applyResolvedTheme(resolved);

    expect(document.documentElement.dataset).toMatchObject({
      theme: 'light',
      themePreference: 'light',
      colorTheme: 'nomo-amber-paper',
      themeStyle: 'paper',
      documentStyle: 'nomo-classic',
      blockStyle: 'classic',
    });
    expect(document.documentElement.style.getPropertyValue('--md-editor-bg')).toBe('#F3F0E8');
    expect(document.documentElement.style.getPropertyValue('--md-editor-code-string')).not.toBe('');
    expect(document.documentElement.style.getPropertyValue('--md-editor-radius-md')).toBe('10px');
    expect(document.documentElement.style.getPropertyValue('--md-editor-font-document')).toBe(
      "'Segoe UI', 'Microsoft YaHei', sans-serif",
    );
  });

  it('round-trips a validated boot snapshot and ignores damaged snapshots', () => {
    const resolved = resolveTheme(
      {
        themeMode: 'dark',
        colorThemeId: 'nomo-amber-paper',
        documentStyleId: 'nomo-modern',
      },
      'light',
    );
    writeThemeBootSnapshot(resolved);
    expect(readThemeBootSnapshot()).toMatchObject({
      themeMode: 'dark',
      colorThemeId: 'nomo-amber-paper',
      effectiveScheme: 'dark',
      styleProfile: 'paper',
    });

    localStorage.setItem(
      THEME_BOOT_SNAPSHOT_KEY,
      '{"schemaVersion":2,"effectiveScheme":"dark","tokens":{},"styleTokens":{}}',
    );
    expect(readThemeBootSnapshot()).toBeNull();
    const fallback = bootstrapThemeFromSnapshot();
    expect(fallback.preferences.colorThemeId).toBe('nomo-default');
    expect(fallback.effectiveScheme).toBe('dark');
  });

  it('restores a valid v1 snapshot with registered v2 style tokens', () => {
    const resolved = resolveTheme(
      {
        themeMode: 'dark',
        colorThemeId: 'nomo-amber-paper',
        documentStyleId: 'nomo-modern',
      },
      'dark',
    );
    localStorage.setItem(
      LEGACY_THEME_BOOT_SNAPSHOT_KEY,
      JSON.stringify({
        schemaVersion: 1,
        themeVersion: resolved.themeVersion,
        themeMode: resolved.preferences.themeMode,
        colorThemeId: resolved.preferences.colorThemeId,
        documentStyleId: resolved.preferences.documentStyleId,
        effectiveScheme: resolved.effectiveScheme,
        tokens: resolved.tokens,
      }),
    );

    expect(readThemeBootSnapshot()).toMatchObject({
      schemaVersion: 2,
      colorThemeId: 'nomo-amber-paper',
      styleProfile: 'paper',
      styleTokens: resolved.styleTokens,
    });
    const restored = bootstrapThemeFromSnapshot();
    expect(restored.styleProfile).toBe('paper');
    expect(document.documentElement.dataset.themeStyle).toBe('paper');
  });

  it('updates the latest editor theme even when the background window never paints', async () => {
    // 模拟后台 WKWebView 不再执行 rAF，主题更新仍须在当前任务结束后完成。
    const pausedAnimationFrame = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', pausedAnimationFrame);
    const editor = { updateTheme: vi.fn() };
    const withoutIcons = applyThemeRuntime(
      {
        themeMode: 'dark',
        colorThemeId: 'nomo-github',
        documentStyleId: 'nomo-modern',
      },
      { desktopEnabled: true, syncDesktopIcons: false, editor },
    );

    expect(withoutIcons.effectiveScheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.colorTheme).toBe('nomo-github');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false);
    expect(editor.updateTheme).not.toHaveBeenCalled();
    expect(setDesktopIconTheme).not.toHaveBeenCalled();

    applyThemeRuntime(
      {
        themeMode: 'light',
        colorThemeId: 'nomo-github',
        documentStyleId: 'nomo-modern',
      },
      { desktopEnabled: true, editor, transition: true },
    );

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.classList.contains('theme-transitioning')).toBe(false);
    expect(editor.updateTheme).not.toHaveBeenCalled();
    expect(setDesktopIconTheme).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(editor.updateTheme).toHaveBeenCalledTimes(1);
    expect(editor.updateTheme).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'light', colorThemeId: 'nomo-github' }),
    );
    expect(setDesktopIconTheme).toHaveBeenCalledWith(true, 'light', expect.any(String));
    expect(pausedAnimationFrame).not.toHaveBeenCalled();
  });

  it('does not apply queued effects after cancellation', async () => {
    const editor = { updateTheme: vi.fn() };
    applyThemeRuntime({ themeMode: 'dark' }, { editor, desktopEnabled: true });
    cancelPendingThemeEffects();
    await Promise.resolve();

    expect(editor.updateTheme).not.toHaveBeenCalled();
    expect(setDesktopIconTheme).not.toHaveBeenCalled();
  });

  it('merges font overrides into style tokens and boot snapshots', () => {
    const resolved = resolveTheme(
      {
        themeMode: 'light',
        colorThemeId: 'nomo-default',
        documentStyleId: 'nomo-modern',
        documentFontFamily: 'LXGW WenKai',
        monoFontFamily: 'bad;font',
      },
      'light',
    );
    const base = resolveTheme({ themeMode: 'light' }, 'light');
    expect(resolved.fonts).toEqual({
      uiFontFamily: '',
      documentFontFamily: 'LXGW WenKai',
      monoFontFamily: '',
    });
    expect(resolved.styleTokens.fontDocument).toBe(
      `"LXGW WenKai", ${base.styleTokens.fontDocument}`,
    );
    expect(resolved.styleTokens.fontMono).toBe(base.styleTokens.fontMono);

    writeThemeBootSnapshot(resolved);
    expect(readThemeBootSnapshot()?.documentFontFamily).toBe('LXGW WenKai');
    bootstrapThemeFromSnapshot();
    expect(document.documentElement.style.getPropertyValue('--md-editor-font-document')).toBe(
      resolved.styleTokens.fontDocument,
    );
  });

  it('accepts v2 boot snapshots written before font overrides existed', () => {
    const resolved = resolveTheme({ themeMode: 'dark', colorThemeId: 'nomo-github' }, 'dark');
    writeThemeBootSnapshot(resolved);
    const stored = JSON.parse(localStorage.getItem(THEME_BOOT_SNAPSHOT_KEY) ?? '{}');
    delete stored.uiFontFamily;
    delete stored.documentFontFamily;
    delete stored.monoFontFamily;
    localStorage.setItem(THEME_BOOT_SNAPSHOT_KEY, JSON.stringify(stored));
    expect(readThemeBootSnapshot()?.colorThemeId).toBe('nomo-github');
  });

  it('routes font changes through the typography geometry channel', () => {
    const preferences = { themeMode: 'light' as const };
    applyThemeRuntime(preferences, { systemScheme: 'light' });
    const sources: (string | undefined)[] = [];
    const subscription = subscribeTypographyInteraction(
      (snapshot) => sources.push(snapshot.geometrySource),
      { geometryParticipant: true },
    );
    sources.length = 0;
    applyThemeRuntime({ ...preferences, colorThemeId: 'nomo-github' }, { systemScheme: 'light' });
    expect(sources).toEqual([]);
    applyThemeRuntime({ ...preferences, documentFontFamily: 'Georgia' }, { systemScheme: 'light' });
    expect(sources).toContain('font');
    expect(document.documentElement.style.getPropertyValue('--md-editor-font-document')).toMatch(
      /^"Georgia", /,
    );
    subscription.destroy();
  });

  it('restores the active user theme from the boot snapshot before the theme directory loads', async () => {
    const { parseUserTheme } = await import('./userThemeDefinition');
    const { themeRegistry } = await import('./themeRegistry');
    const theme = parseUserTheme({
      schemaVersion: 1,
      id: 'user-boot',
      localizedNames: { 'en-US': 'Boot' },
      variants: { dark: { tokens: { accent: '#ff8800' } } },
    });
    themeRegistry.registerTheme(theme, { replace: true });
    writeThemeBootSnapshot(resolveTheme({ themeMode: 'dark', colorThemeId: 'user-boot' }, 'dark'));
    themeRegistry.unregisterTheme('user-boot');

    const snapshot = readThemeBootSnapshot();
    expect(snapshot?.colorThemeId).toBe('user-boot');
    expect(snapshot?.tokens.accent).toBe('#ff8800');
    themeRegistry.unregisterTheme('user-boot');

    const stored = JSON.parse(localStorage.getItem(THEME_BOOT_SNAPSHOT_KEY) ?? '{}');
    stored.userThemeSource = '{"broken"';
    localStorage.setItem(THEME_BOOT_SNAPSHOT_KEY, JSON.stringify(stored));
    expect(readThemeBootSnapshot()).toBeNull();
  });

  it('falls back for invalid theme and document style identifiers', () => {
    const resolved = resolveTheme({
      themeMode: 'system',
      colorThemeId: 'not-installed',
      documentStyleId: 'not-installed',
    });

    expect(resolved.preferences).toMatchObject({
      colorThemeId: 'nomo-default',
      documentStyleId: 'nomo-modern',
    });
  });
});
