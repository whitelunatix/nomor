import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { authStyleFor } from './config';
import { createGatewayFetch } from './gateway';
import type { AssistantProviderConfig } from './types';

/**
 * 占位密钥：provider 要求 apiKey 非空才会发请求，但真实密钥在 Rust 侧注入，
 * 这个值永远不会离开 webview，也不会上网。
 */
const PLACEHOLDER_API_KEY = 'nomo-managed';

export function createAssistantModel(provider: AssistantProviderConfig): LanguageModel {
  const auth = authStyleFor(provider.kind);
  const fetch = createGatewayFetch({ providerId: provider.id, auth });

  if (provider.kind === 'anthropic') {
    const anthropic = createAnthropic({
      baseURL: provider.baseUrl,
      apiKey: PLACEHOLDER_API_KEY,
      headers: provider.headers,
      fetch,
    });
    return anthropic(provider.model);
  }

  const openai = createOpenAICompatible({
    name: 'nomo',
    baseURL: provider.baseUrl,
    apiKey: PLACEHOLDER_API_KEY,
    headers: provider.headers,
    fetch,
    includeUsage: true,
  });
  return openai.chatModel(provider.model);
}
