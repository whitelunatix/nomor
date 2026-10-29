import { APICallError, isStepCount, streamText, type ModelMessage, type ToolSet } from 'ai';
import { t } from '../../app/i18n';
import { formatToolOutput } from './context';
import { createAssistantModel } from './model';
import type { AssistantProviderConfig, AssistantTurnResult, AssistantUsage } from './types';

/** 单轮对话里最多允许的「模型 → 工具 → 模型」步数。 */
export const DEFAULT_MAX_STEPS = 12;

export interface AssistantToolCallEvent {
  id: string;
  name: string;
  input: unknown;
}

export interface AssistantTurnOptions {
  provider: AssistantProviderConfig;
  /** 本轮之前的历史（不含本轮用户输入）。 */
  history: ModelMessage[];
  userText: string;
  system: string;
  tools: ToolSet;
  signal: AbortSignal;
  maxSteps?: number;
  onTextDelta?(text: string): void;
  onReasoningDelta?(text: string): void;
  onToolCall?(event: AssistantToolCallEvent): void;
  onToolResult?(
    event: AssistantToolCallEvent & { output: string; denied?: boolean; reason?: string },
  ): void;
  onToolError?(event: AssistantToolCallEvent & { message: string }): void;
  /** 流式过程中的错误；返回后本轮结束。 */
  onError?(message: string): void;
}

/** 把 SDK / 网络错误收敛成一句可展示的说明（跟随界面语言）。 */
export function describeAssistantError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? t.aiErrorHttpStatus({ code: error.statusCode }) : '';
    const body = error.responseBody?.trim();
    if (body) {
      return t.aiErrorApiWithBody({ status, body: body.slice(0, 500) });
    }
    return t.aiErrorApi({ status, message: error.message });
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return t.aiStopped();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** 工具拒绝时返回 `{ denied: true, reason }`，让界面显示「已拒绝」而不是「完成」。 */
export function readDeniedOutput(
  output: unknown,
): { denied: true; reason?: string } | null {
  if (!output || typeof output !== 'object') {
    return null;
  }
  const record = output as { denied?: unknown; reason?: unknown };
  if (record.denied !== true) {
    return null;
  }
  return {
    denied: true,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
}

function readUsage(usage: unknown): AssistantUsage {
  if (!usage || typeof usage !== 'object') {
    return {};
  }
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: typeof record.inputTokens === 'number' ? record.inputTokens : undefined,
    outputTokens: typeof record.outputTokens === 'number' ? record.outputTokens : undefined,
    totalTokens: typeof record.totalTokens === 'number' ? record.totalTokens : undefined,
  };
}

/**
 * 跑完一轮：模型可以多次调用工具，工具结果自动回填，直到模型给出最终回答或达到步数上限。
 * 返回值里带上本轮新增的模型消息，调用方追加到历史即可继续下一轮。
 */
export async function runAssistantTurn(
  options: AssistantTurnOptions,
): Promise<AssistantTurnResult> {
  const {
    provider,
    history,
    userText,
    system,
    tools,
    signal,
    maxSteps = DEFAULT_MAX_STEPS,
  } = options;

  const model = createAssistantModel(provider);
  const userMessage: ModelMessage = { role: 'user', content: userText };
  const result = streamText({
    model,
    system,
    messages: [...history, userMessage],
    tools,
    stopWhen: isStepCount(maxSteps),
    abortSignal: signal,
  });

  let text = '';
  let streamError: string | null = null;

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += part.text;
          options.onTextDelta?.(part.text);
          break;
        case 'reasoning-delta':
          options.onReasoningDelta?.(part.text);
          break;
        case 'tool-call':
          options.onToolCall?.({
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          });
          break;
        case 'tool-result': {
          const denied = readDeniedOutput(part.output);
          options.onToolResult?.({
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
            output: formatToolOutput(part.output),
            denied: denied?.denied,
            reason: denied?.reason,
          });
          break;
        }
        case 'tool-error':
          options.onToolError?.({
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
            message: describeAssistantError(part.error),
          });
          break;
        case 'abort':
          break;
        case 'error':
          streamError ??= describeAssistantError(part.error);
          break;
        default:
          break;
      }
    }
  } catch (error) {
    streamError ??= signal.aborted ? t.aiStopped() : describeAssistantError(error);
  }

  if (streamError && !signal.aborted) {
    options.onError?.(streamError);
  }

  const messages: ModelMessage[] = [userMessage];
  try {
    const responseMessages = await result.responseMessages;
    messages.push(...(responseMessages as ModelMessage[]));
  } catch {
    // 中止或出错时拿不到完整的助手消息，只保留用户输入，避免历史里出现半条工具调用。
  }

  let usage: AssistantUsage = {};
  try {
    usage = readUsage(await result.usage);
  } catch {
    // 同上。
  }

  return {
    messages,
    text,
    usage,
    aborted: signal.aborted,
  };
}
