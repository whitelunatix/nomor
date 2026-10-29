import { invoke } from '@tauri-apps/api/core';
import { t } from '../../app/i18n';
import { isTauriRuntime, listAppSettings, updateAppSetting } from '../desktop/tauriStorage';
import {
  ASSISTANT_PREFERENCES_KEY,
  DEFAULT_ASSISTANT_PREFERENCES,
  authStyleFor,
  normalizeAssistantPreferences,
} from './config';
import type { AssistantPreferences, AssistantProviderConfig } from './types';

export interface ProbeResult {
  status: number;
  body: string;
}

export async function loadAssistantPreferences(): Promise<AssistantPreferences> {
  if (!isTauriRuntime()) {
    return normalizeAssistantPreferences(null);
  }
  const rows = await listAppSettings().catch(() => []);
  const row = rows.find((item) => item.key === ASSISTANT_PREFERENCES_KEY);
  if (!row) {
    return normalizeAssistantPreferences(null);
  }
  try {
    return normalizeAssistantPreferences(JSON.parse(row.valueJson));
  } catch {
    return normalizeAssistantPreferences(null);
  }
}

export async function saveAssistantPreferences(preferences: AssistantPreferences): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error(t.aiSettingsDesktopOnly());
  }
  await updateAppSetting(ASSISTANT_PREFERENCES_KEY, preferences);
}

export function assistantPreferencesOrNull(value: unknown): AssistantPreferences | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const preferences = normalizeAssistantPreferences(value);
  return preferences.providers.length > 0 ? preferences : null;
}

export async function hasAssistantApiKey(providerId: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    return false;
  }
  return invoke<boolean>('assistant_has_api_key', { providerId });
}

export async function setAssistantApiKey(providerId: string, apiKey: string): Promise<void> {
  await invoke('assistant_set_api_key', { providerId, apiKey });
}

export async function deleteAssistantApiKey(providerId: string): Promise<void> {
  await invoke('assistant_delete_api_key', { providerId });
}

/**
 * 连通性测试与模型列表共用。`url` 由调用方拼好，例如 `${baseUrl}/models`。
 * 密钥由 Rust 注入，这里不需要也不允许传。
 */
export async function probeAssistantProvider(
  provider: AssistantProviderConfig,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<ProbeResult> {
  const base = provider.baseUrl.replace(/\/+$/, '');
  return invoke<ProbeResult>('assistant_probe', {
    request: {
      providerId: provider.id,
      url: `${base}${path}`,
      method: init.method ?? 'GET',
      headers: Object.entries({ ...provider.headers, ...init.headers }),
      body: init.body ?? null,
      auth: authStyleFor(provider.kind),
    },
  });
}

/** 测试连通性：OpenAI 兼容读模型列表，Anthropic 发一个最小 messages 请求。 */
export async function testAssistantProvider(
  provider: AssistantProviderConfig,
): Promise<{ ok: boolean; message: string }> {
  try {
    if (provider.kind === 'anthropic') {
      const result = await probeAssistantProvider(provider, '/messages', {
        method: 'POST',
        headers: { 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return result.status >= 200 && result.status < 300
        ? { ok: true, message: t.aiSettingsConnectOk() }
        : { ok: false, message: `HTTP ${result.status}：${result.body.slice(0, 300)}` };
    }

    const result = await probeAssistantProvider(provider, '/models');
    if (result.status >= 200 && result.status < 300) {
      return { ok: true, message: t.aiSettingsConnectOk() };
    }
    return { ok: false, message: `HTTP ${result.status}：${result.body.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 读取 OpenAI 兼容服务商的模型列表；失败时返回空数组，由界面提示用户手填。 */
export async function listProviderModels(provider: AssistantProviderConfig): Promise<string[]> {
  if (provider.kind === 'anthropic') {
    return [];
  }
  try {
    const result = await probeAssistantProvider(provider, '/models');
    if (result.status < 200 || result.status >= 300) {
      return [];
    }
    const payload = JSON.parse(result.body) as { data?: Array<{ id?: unknown }> };
    return (payload.data ?? [])
      .map((item) => (typeof item.id === 'string' ? item.id : null))
      .filter((id): id is string => !!id)
      .sort();
  } catch {
    return [];
  }
}

export { DEFAULT_ASSISTANT_PREFERENCES };
