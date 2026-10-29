import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_PREFERENCES,
  PRESET_PROVIDERS,
  authStyleFor,
  createProviderFromPreset,
  findProvider,
  isProviderIdValid,
  normalizeAssistantPreferences,
} from './config';

describe('normalizeAssistantPreferences', () => {
  it('没有设置时退回默认值', () => {
    const preferences = normalizeAssistantPreferences(null);
    expect(preferences.providers).toEqual([]);
    expect(preferences.activeProviderId).toBe('');
    expect(preferences.shellEnabled).toBe(DEFAULT_ASSISTANT_PREFERENCES.shellEnabled);
    expect(preferences.documentWriteEnabled).toBe(
      DEFAULT_ASSISTANT_PREFERENCES.documentWriteEnabled,
    );
    expect(preferences.fileWriteEnabled).toBe(false);
    expect(preferences.autoCompactionEnabled).toBe(true);
  });

  it('自动摘要只能显式关闭', () => {
    expect(
      normalizeAssistantPreferences({ autoCompactionEnabled: false }).autoCompactionEnabled,
    ).toBe(false);
    expect(
      normalizeAssistantPreferences({ autoCompactionEnabled: 'no' }).autoCompactionEnabled,
    ).toBe(true);
  });

  it('文件写入只接受显式 true', () => {
    expect(
      normalizeAssistantPreferences({ fileWriteEnabled: true }).fileWriteEnabled,
    ).toBe(true);
    expect(
      normalizeAssistantPreferences({ fileWriteEnabled: 'yes' }).fileWriteEnabled,
    ).toBe(false);
  });

  it('丢弃 id 非法或字段缺失的服务商', () => {
    const preferences = normalizeAssistantPreferences({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        { id: '带中文', name: '坏 id', baseUrl: 'https://example.com/v1', model: 'm' },
        { id: 'no-model', name: '缺模型', baseUrl: 'https://example.com/v1' },
        { id: 'no-url', name: '缺地址', baseUrl: '', model: 'm' },
      ],
    });
    expect(preferences.providers.map((provider) => provider.id)).toEqual(['deepseek']);
  });

  it('去掉 baseUrl 末尾斜杠并把 kind 归一到两类', () => {
    const preferences = normalizeAssistantPreferences({
      providers: [
        {
          id: 'a',
          name: 'A',
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1///',
          model: 'claude',
        },
        { id: 'b', name: 'B', kind: 'unknown', baseUrl: 'https://example.com/v1', model: 'm' },
      ],
    });
    expect(preferences.providers[0]).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    expect(preferences.providers[1]!.kind).toBe('openai-compatible');
  });

  it('activeProviderId 失效时回退到第一个服务商', () => {
    const preferences = normalizeAssistantPreferences({
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://example.com/v1', model: 'm' },
        { id: 'b', name: 'B', baseUrl: 'https://example.com/v1', model: 'm' },
      ],
      activeProviderId: 'missing',
    });
    expect(preferences.activeProviderId).toBe('a');
  });

  it('过滤非字符串请求头', () => {
    const preferences = normalizeAssistantPreferences({
      providers: [
        {
          id: 'a',
          name: 'A',
          baseUrl: 'https://example.com/v1',
          model: 'm',
          headers: { 'X-Trace': 'on', '': 'empty', 'X-Number': 1 },
        },
      ],
    });
    expect(preferences.providers[0]!.headers).toEqual({ 'X-Trace': 'on' });
  });
});

describe('provider helpers', () => {
  it('校验 provider id 与 Rust 侧规则一致', () => {
    expect(isProviderIdValid('deepseek-2')).toBe(true);
    expect(isProviderIdValid('a'.repeat(64))).toBe(true);
    expect(isProviderIdValid('a'.repeat(65))).toBe(false);
    expect(isProviderIdValid('中文')).toBe(false);
    expect(isProviderIdValid('has space')).toBe(false);
  });

  it('Anthropic 用 x-api-key，其余用 Bearer', () => {
    expect(authStyleFor('anthropic')).toBe('xApiKey');
    expect(authStyleFor('openai-compatible')).toBe('bearer');
  });

  it('findProvider 优先用传入 id，其次是 activeProviderId', () => {
    const preferences = normalizeAssistantPreferences({
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://example.com/v1', model: 'm' },
        { id: 'b', name: 'B', baseUrl: 'https://example.com/v1', model: 'm' },
      ],
      activeProviderId: 'b',
    });
    expect(findProvider(preferences)?.id).toBe('b');
    expect(findProvider(preferences, 'a')?.id).toBe('a');
    expect(findProvider(preferences, 'missing')).toBeNull();
  });

  it('预设副本 id 冲突时自动加序号', () => {
    const first = createProviderFromPreset('deepseek', []);
    expect(first?.id).toBe('deepseek');

    const second = createProviderFromPreset('deepseek', [first!]);
    expect(second).toMatchObject({ id: 'deepseek-2', name: 'DeepSeek 2' });

    const third = createProviderFromPreset('deepseek', [first!, second!]);
    expect(third?.id).toBe('deepseek-3');

    expect(createProviderFromPreset('nope', [])).toBeNull();
  });

  it('预设里的地址都不带末尾斜杠', () => {
    for (const preset of PRESET_PROVIDERS) {
      expect(preset.baseUrl.endsWith('/')).toBe(false);
      expect(isProviderIdValid(preset.id)).toBe(true);
    }
  });
});
