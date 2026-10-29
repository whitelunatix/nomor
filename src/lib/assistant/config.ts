import type {
  AssistantAuthStyle,
  AssistantPreferences,
  AssistantProviderConfig,
  AssistantProviderKind,
} from './types';

/** 与 Rust 侧 `assistant::secrets::validate_provider_id` 保持一致。 */
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ASSISTANT_PREFERENCES_KEY = 'assistantPreferences';

export const PRESET_PROVIDERS: readonly AssistantProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
  },
];

export const DEFAULT_ASSISTANT_PREFERENCES: AssistantPreferences = {
  providers: [],
  activeProviderId: '',
  shellEnabled: true,
  documentWriteEnabled: true,
  fileWriteEnabled: false,
  autoCompactionEnabled: true,
  skillsRoot: '',
};

export function isProviderIdValid(id: string): boolean {
  return PROVIDER_ID_PATTERN.test(id);
}

export function authStyleFor(kind: AssistantProviderKind): AssistantAuthStyle {
  return kind === 'anthropic' ? 'xApiKey' : 'bearer';
}

function normalizeProvider(value: unknown): AssistantProviderConfig | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const kind = record.kind === 'anthropic' ? 'anthropic' : 'openai-compatible';
  const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!isProviderIdValid(id) || !name || !baseUrl || !model) {
    return null;
  }

  const headers: Record<string, string> = {};
  if (record.headers && typeof record.headers === 'object') {
    for (const [key, headerValue] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof headerValue === 'string' && key.trim()) {
        headers[key.trim()] = headerValue;
      }
    }
  }

  return {
    id,
    name,
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** 读取设置时的兜底：任何字段坏了都退回默认值，而不是让整个面板起不来。 */
export function normalizeAssistantPreferences(value: unknown): AssistantPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_ASSISTANT_PREFERENCES, providers: [] };
  }
  const record = value as Record<string, unknown>;
  const providers = Array.isArray(record.providers)
    ? record.providers
        .map(normalizeProvider)
        .filter((provider): provider is AssistantProviderConfig => provider !== null)
    : [];
  const activeProviderId =
    typeof record.activeProviderId === 'string' &&
    providers.some((provider) => provider.id === record.activeProviderId)
      ? record.activeProviderId
      : (providers[0]?.id ?? '');

  return {
    providers,
    activeProviderId,
    shellEnabled:
      typeof record.shellEnabled === 'boolean'
        ? record.shellEnabled
        : DEFAULT_ASSISTANT_PREFERENCES.shellEnabled,
    documentWriteEnabled:
      typeof record.documentWriteEnabled === 'boolean'
        ? record.documentWriteEnabled
        : DEFAULT_ASSISTANT_PREFERENCES.documentWriteEnabled,
    fileWriteEnabled:
      typeof record.fileWriteEnabled === 'boolean'
        ? record.fileWriteEnabled
        : DEFAULT_ASSISTANT_PREFERENCES.fileWriteEnabled,
    autoCompactionEnabled:
      typeof record.autoCompactionEnabled === 'boolean'
        ? record.autoCompactionEnabled
        : DEFAULT_ASSISTANT_PREFERENCES.autoCompactionEnabled,
    skillsRoot: typeof record.skillsRoot === 'string' ? record.skillsRoot : '',
  };
}

export function findProvider(
  preferences: AssistantPreferences,
  providerId?: string,
): AssistantProviderConfig | null {
  const id = providerId ?? preferences.activeProviderId;
  return preferences.providers.find((provider) => provider.id === id) ?? null;
}

/** 用预设创建一份可编辑的副本；id 冲突时自动加序号。 */
export function createProviderFromPreset(
  presetId: string,
  existing: readonly AssistantProviderConfig[],
): AssistantProviderConfig | null {
  const preset = PRESET_PROVIDERS.find((item) => item.id === presetId);
  if (!preset) {
    return null;
  }
  const usedIds = new Set(existing.map((provider) => provider.id));
  if (!usedIds.has(preset.id)) {
    return { ...preset };
  }
  let index = 2;
  while (usedIds.has(`${preset.id}-${index}`)) {
    index += 1;
  }
  return { ...preset, id: `${preset.id}-${index}`, name: `${preset.name} ${index}` };
}
