import { Channel, invoke } from '@tauri-apps/api/core';
import { t } from '../../app/i18n';
import type { AssistantAuthStyle } from './types';

/**
 * 注入给 AI SDK 的 `fetch`：请求交给 Rust 发（密钥不出 webview），
 * 响应体通过 Tauri `Channel` 逐片转成标准 `ReadableStream`。
 */

export interface GatewayStartInfo {
  status: number;
  headers: Array<[string, string]>;
}

type GatewayEvent =
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

export interface GatewayFetchOptions {
  providerId: string;
  auth: AssistantAuthStyle;
}

/** 这些头由本地重新生造响应时已经失真，直接丢弃。 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

const STATUS_WITHOUT_BODY = new Set([204, 205, 304]);

function createStreamId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function collectHeaders(headers: HeadersInit | undefined): Array<[string, string]> {
  const collected: Array<[string, string]> = [];
  new Headers(headers ?? {}).forEach((value, key) => {
    collected.push([key, value]);
  });
  return collected;
}

async function readRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body == null && typeof Request !== 'undefined' && input instanceof Request) {
    return input.text();
  }
  throw new Error(t.aiErrorBodyUnsupported());
}

function responseHeaders(raw: Array<[string, string]>): Headers {
  const headers = new Headers();
  for (const [name, value] of raw) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }
  return headers;
}

export function createGatewayFetch({ providerId, auth }: GatewayFetchOptions): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input);
    const body = await readRequestBody(input, init);
    const headers = collectHeaders(init?.headers);
    const streamId = createStreamId();

    // 控制器只在 `start` 回调里拿得到，用对象包一层，
    // 避免 TS 的控制流分析把它在闭包里收窄成 `never`。
    const sink: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
      controller: null,
    };
    let closed = false;
    const encoder = new TextEncoder();

    const abortSignal =
      init?.signal ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);

    const stopRemoteStream = () => {
      void invoke('assistant_stream_cancel', { streamId }).catch(() => {});
    };

    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        sink.controller = nextController;
      },
      cancel() {
        closed = true;
        abortSignal?.removeEventListener('abort', cancelStream);
        stopRemoteStream();
      },
    });

    const cancelStream = () => {
      closed = true;
      abortSignal?.removeEventListener('abort', cancelStream);
      stopRemoteStream();
      try {
        sink.controller?.error(new DOMException('已取消', 'AbortError'));
      } catch {
        // 流已结束。
      }
    };
    abortSignal?.addEventListener('abort', cancelStream, { once: true });

    const channel = new Channel<GatewayEvent>();
    channel.onmessage = (event) => {
      if (event.type === 'chunk') {
        if (!closed) {
          sink.controller?.enqueue(encoder.encode(event.data));
        }
        return;
      }
      closed = true;
      abortSignal?.removeEventListener('abort', cancelStream);
      if (event.type === 'end') {
        try {
          sink.controller?.close();
        } catch {
          // 已经关闭或已出错，忽略。
        }
        return;
      }
      try {
        sink.controller?.error(new Error(event.message));
      } catch {
        // 同上。
      }
    };

    try {
      const started = await invoke<GatewayStartInfo>('assistant_stream_start', {
        request: { streamId, providerId, url, headers, body, auth },
      });
      if (STATUS_WITHOUT_BODY.has(started.status)) {
        closed = true;
        try {
          sink.controller?.close();
        } catch {
          // 忽略。
        }
        return new Response(null, { status: started.status });
      }
      return new Response(stream, {
        status: started.status,
        headers: responseHeaders(started.headers),
      });
    } catch (error) {
      closed = true;
      abortSignal?.removeEventListener('abort', cancelStream);
      try {
        sink.controller?.error(error);
      } catch {
        // 忽略。
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
}
