import { generateText, type ModelMessage } from 'ai';
import { writable, type Readable } from 'svelte/store';
import type { EditorCore } from '../../lib/editor-core/types';
import {
  ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../../lib/assistant/approval';
import { describeAssistantError, runAssistantTurn } from '../../lib/assistant/agent';
import {
  compactHistory,
  CONTEXT_HARD_LIMIT,
  estimateMessagesTokens,
  SUMMARY_INSTRUCTION,
  SUMMARY_OUTPUT_TOKENS,
} from '../../lib/assistant/compaction';
import { expandComposerInput } from '../../lib/assistant/composer';
import { findProvider, normalizeAssistantPreferences } from '../../lib/assistant/config';
import { estimateTokens } from '../../lib/assistant/context';
import { loadMcpTools } from '../../lib/assistant/mcp';
import { createAssistantModel } from '../../lib/assistant/model';
import { buildSystemPrompt } from '../../lib/assistant/prompts';
import { listSkills } from '../../lib/assistant/skills';
import {
  appendAssistantSession,
  createSessionId,
  deleteAssistantSession,
  deriveSessionTitle,
  listAssistantSessions,
  messageToRecord,
  readAssistantSession,
  recordsToMessages,
  renameAssistantSession,
  syncAssistantSession,
  usageFromRecords,
  usageToRecord,
} from '../../lib/assistant/sessions';
import {
  hasAssistantApiKey,
  loadAssistantPreferences,
  saveAssistantPreferences,
} from '../../lib/assistant/settings';
import { createAssistantTools } from '../../lib/assistant/tools';
import type {
  AssistantMessage,
  AssistantPreferences,
  AssistantSessionSummary,
  AssistantToolInvocation,
  AssistantUsage,
} from '../../lib/assistant/types';
import { t } from '../i18n';

/**
 * AI 面板的会话状态机。
 *
 * 组件只读 `state`、调用方法；模型循环、工具审批、会话落盘都收在这里，
 * 这样 UI 换皮或加 MCP/shell 工具都不需要改面板本身。
 */

export interface AiControllerOptions {
  /** 每次调用都重新取，切换标签页后自动指向当前编辑器。 */
  getEditor: () => EditorCore | null;
  isDocxMode: () => boolean;
  getDocumentTitle: () => string | null;
  isReadonly: () => boolean;
  /** 当前文档的绝对路径；未保存时返回 null，此时不注入文件工具。 */
  getDocumentPath: () => string | null;
  /** 当前选区文本；用于 composer 的 `@选区`。 */
  getSelectionText?: () => string | null;
}

export interface AiPanelState {
  /** 首次读取设置完成前为 true。 */
  loading: boolean;
  preferences: AssistantPreferences;
  /** 已保存密钥的服务商 id；只用于提示，不涉及密钥内容。 */
  providersWithKey: string[];
  sessions: AssistantSessionSummary[];
  sessionId: string;
  messages: AssistantMessage[];
  streaming: boolean;
  error: string | null;
  approval: ApprovalRequest | null;
  usage: AssistantUsage | null;
  /** MCP / 技能目录加载失败等非致命提示；可手动关闭。 */
  warning: string | null;
  /** 上下文预算：used 是历史 + 摘要的估算，budget 是硬上限。 */
  context: {
    used: number;
    budget: number;
    summaryActive: boolean;
    degraded: boolean;
  };
}

/**
 * 面板关闭再打开时恢复同一会话。只记在内存里：应用重启后从「会话列表」手动选。
 */
let lastActiveSessionId: string | null = null;

export interface AiController {
  state: Readable<AiPanelState>;
  initialize(): Promise<void>;
  reloadPreferences(): Promise<void>;
  setActiveProvider(providerId: string): Promise<void>;
  send(text: string): Promise<void>;
  /** 重跑指定助手消息；它之后的对话会被截断。 */
  regenerate(messageId: string): Promise<void>;
  /** 修改指定用户消息并重跑；它之后的对话会被截断。 */
  editAndResend(messageId: string, text: string): Promise<void>;
  /** 失败后重试：等价于重新生成该轮。 */
  retry(messageId: string): Promise<void>;
  stop(): void;
  decideApproval(decision: ApprovalDecision): void;
  newSession(): void;
  selectSession(id: string): Promise<void>;
  removeSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  refreshSessions(): Promise<void>;
  /** 展示一条可关闭的中性提示（导出成功等）。 */
  notify(message: string): void;
  clearWarning(): void;
  dispose(): void;
}

function initialPreferences(): AssistantPreferences {
  return normalizeAssistantPreferences(null);
}

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把已落盘的消息还原成模型能读的纯文本历史（工具调用不重放）。 */
function toModelHistory(messages: readonly AssistantMessage[]): ModelMessage[] {
  const history: ModelMessage[] = [];
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    history.push({ role: message.role, content });
  }
  return history;
}

export function createAiController(options: AiControllerOptions): AiController {
  const state = writable<AiPanelState>({
    loading: true,
    preferences: initialPreferences(),
    providersWithKey: [],
    sessions: [],
    sessionId: createSessionId(),
    messages: [],
    streaming: false,
    error: null,
    approval: null,
    usage: null,
    warning: null,
    context: { used: 0, budget: CONTEXT_HARD_LIMIT, summaryActive: false, degraded: false },
  });

  const approval = new ApprovalBroker();
  const unsubscribeApproval = approval.subscribe((current) => {
    state.update((value) => ({ ...value, approval: current }));
    // 审批队列每次只展示队首；把对应卡片标成「等待确认」。
    if (current?.toolCallId) {
      upsertToolCall(
        { id: current.toolCallId, name: current.toolName },
        { status: 'pending-approval' },
      );
    }
  });

  /** 精确的模型消息历史（含工具调用）；落盘只存可展示的消息。 */
  let modelHistory: ModelMessage[] = [];
  /** 较早消息的摘要；作为 system 背景，不伪造消息。 */
  let summaryText: string | null = null;
  let contextDegraded = false;
  let sessionTitle = '';
  let abortController: AbortController | null = null;
  let streamingAssistantId: string | null = null;
  let disposed = false;

  function snapshot(): AiPanelState {
    let value: AiPanelState | undefined;
    const unsubscribe = state.subscribe((next) => {
      value = next;
    });
    unsubscribe();
    return value!;
  }

  function setContext(history: readonly ModelMessage[], degraded = contextDegraded): void {
    contextDegraded = degraded;
    const used = estimateMessagesTokens(history) + estimateTokens(summaryText ?? '');
    state.update((value) => ({
      ...value,
      context: {
        used,
        budget: CONTEXT_HARD_LIMIT,
        summaryActive: Boolean(summaryText),
        degraded,
      },
    }));
  }

  function patchAssistant(patch: (message: AssistantMessage) => AssistantMessage): void {
    const id = streamingAssistantId;
    if (!id) {
      return;
    }
    state.update((value) => ({
      ...value,
      messages: value.messages.map((message) => (message.id === id ? patch(message) : message)),
    }));
  }

  function upsertToolCall(
    call: { id: string; name: string; input?: unknown },
    patch: Partial<AssistantToolInvocation>,
  ): void {
    patchAssistant((message) => {
      const calls = message.toolCalls ? [...message.toolCalls] : [];
      const index = calls.findIndex((item) => item.id === call.id);
      if (index >= 0) {
        calls[index] = { ...calls[index]!, ...patch };
      } else {
        calls.push({
          id: call.id,
          name: call.name,
          title: call.name,
          status: 'running',
          input: call.input,
          startedAt: Date.now(),
          ...patch,
        });
      }
      return { ...message, toolCalls: calls };
    });
  }

  async function refreshProvidersWithKey(preferences: AssistantPreferences): Promise<string[]> {
    const entries = await Promise.all(
      preferences.providers.map(async (provider) => {
        const has = await hasAssistantApiKey(provider.id).catch(() => false);
        return has ? provider.id : null;
      }),
    );
    return entries.filter((id): id is string => id !== null);
  }

  async function loadErrorSafe<T>(task: Promise<T>, fallback: T): Promise<T> {
    try {
      return await task;
    } catch {
      return fallback;
    }
  }

  function setWarning(message: string | null): void {
    state.update((value) => ({ ...value, warning: message }));
  }

  async function initialize(): Promise<void> {
    const preferences = await loadErrorSafe(loadAssistantPreferences(), initialPreferences());
    if (disposed) {
      return;
    }
    const providersWithKey = await refreshProvidersWithKey(preferences);
    const sessions = await loadErrorSafe(listAssistantSessions(), []);
    if (disposed) {
      return;
    }
    state.update((value) => ({
      ...value,
      loading: false,
      preferences,
      providersWithKey,
      sessions,
    }));

    // 面板关闭后重新打开时，接着刚才的会话继续。
    const restoreId =
      lastActiveSessionId && sessions.some((session) => session.id === lastActiveSessionId)
        ? lastActiveSessionId
        : null;
    if (restoreId) {
      await selectSession(restoreId, true);
    }
  }

  async function reloadPreferences(): Promise<void> {
    const preferences = await loadErrorSafe(loadAssistantPreferences(), initialPreferences());
    if (disposed) {
      return;
    }
    const providersWithKey = await refreshProvidersWithKey(preferences);
    if (disposed) {
      return;
    }
    state.update((value) => ({ ...value, preferences, providersWithKey }));
  }

  async function setActiveProvider(providerId: string): Promise<void> {
    const current = snapshot();
    if (!current.preferences.providers.some((provider) => provider.id === providerId)) {
      return;
    }
    const preferences = { ...current.preferences, activeProviderId: providerId };
    state.update((value) => ({ ...value, preferences }));
    await saveAssistantPreferences(preferences).catch(() => undefined);
  }

  function resetConversation(): void {
    modelHistory = [];
    summaryText = null;
    contextDegraded = false;
    sessionTitle = '';
    const sessionId = createSessionId();
    lastActiveSessionId = sessionId;
    state.update((value) => ({
      ...value,
      sessionId,
      messages: [],
      error: null,
      usage: null,
      approval: null,
      warning: null,
      context: { used: 0, budget: CONTEXT_HARD_LIMIT, summaryActive: false, degraded: false },
    }));
  }

  function newSession(): void {
    abortController?.abort();
    approval.cancelAll();
    resetConversation();
  }

  async function selectSession(id: string, restore = false): Promise<void> {
    if (!id || (!restore && id === snapshot().sessionId)) {
      return;
    }
    abortController?.abort();
    approval.cancelAll();
    try {
      const payload = await readAssistantSession(id);
      const messages = recordsToMessages(payload.records);
      modelHistory = toModelHistory(messages);
      // 摘要只属于当前上下文，切换会话后重新开始累积。
      summaryText = null;
      contextDegraded = false;
      sessionTitle = payload.meta.title;
      lastActiveSessionId = id;
      state.update((value) => ({
        ...value,
        sessionId: id,
        messages,
        error: null,
        usage: usageFromRecords(payload.records),
        approval: null,
      }));
      // 损坏行不静默吞掉：给出数量，完整原因由 Rust 日志/文件保留。
      const warningCount = payload.warnings?.length ?? 0;
      setWarning(
        warningCount > 0 ? t.aiSessionRecovered({ count: String(warningCount) }) : null,
      );
      setContext(modelHistory, false);
    } catch (error) {
      state.update((value) => ({
        ...value,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function removeSession(id: string): Promise<void> {
    await deleteAssistantSession(id).catch(() => undefined);
    if (snapshot().sessionId === id) {
      resetConversation();
    }
    await refreshSessions();
  }

  async function refreshSessions(): Promise<void> {
    const sessions = await loadErrorSafe(listAssistantSessions(), []);
    if (disposed) {
      return;
    }
    state.update((value) => ({ ...value, sessions }));
  }

  /** 发送时按当前文档/选区展开 composer 命令；可见消息里保留用户原始输入。 */
  function expand(text: string): string {
    return expandComposerInput(text, {
      documentTitle: options.getDocumentTitle(),
      documentPath: options.getDocumentPath(),
      selection: options.getSelectionText?.() ?? null,
    });
  }

  async function persistTurn(
    mode: 'append' | 'sync',
    titleSeed: string,
    records: unknown[],
  ): Promise<void> {
    const current = snapshot();
    const id = current.sessionId;
    const title = sessionTitle || deriveSessionTitle(titleSeed);
    const notice = await loadErrorSafe(
      mode === 'append'
        ? appendAssistantSession(id, title || null, records)
        : syncAssistantSession(id, title || null, records),
      null,
    );
    if (notice) {
      sessionTitle = notice.title;
      lastActiveSessionId = id;
    }
    await refreshSessions();
  }

  interface TurnRequest {
    /** 发给模型的用户文本（可能已展开 `@文档` / `@选区`）。 */
    userText: string;
    userMessage: AssistantMessage;
    /** 本轮之前的模型历史。 */
    history: ModelMessage[];
    /** 当前可见消息，含本轮用户消息、不含助手占位。 */
    visibleBefore: AssistantMessage[];
    mode: 'append' | 'sync';
  }

  async function executeTurn(request: TurnRequest): Promise<void> {
    const current = snapshot();
    const provider = findProvider(current.preferences);
    if (!provider) {
      state.update((value) => ({ ...value, error: t.aiErrorNoProvider() }));
      return;
    }
    const providersWithKey = await refreshProvidersWithKey(current.preferences);
    state.update((value) => ({ ...value, providersWithKey }));
    if (!providersWithKey.includes(provider.id)) {
      state.update((value) => ({
        ...value,
        error: t.aiErrorNoKey({ name: provider.name }),
      }));
      return;
    }

    const editor = options.getEditor();
    const documentPath = options.getDocumentPath();
    const assistantMessage: AssistantMessage = {
      id: createMessageId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      toolCalls: [],
    };

    streamingAssistantId = assistantMessage.id;
    abortController = new AbortController();
    const signal = abortController.signal;
    const usage: { value: AssistantUsage | null } = { value: null };

    state.update((value) => ({
      ...value,
      messages: [...request.visibleBefore, assistantMessage],
      streaming: true,
      error: null,
      usage: null,
      warning: null,
    }));

    // MCP 服务器按需连接，第一次可能要先起子进程：面板已进入「思考中」再等。
    // 技能目录只扫一层，代价很小；发送前重扫，用户新增技能不用重启。
    let mcpServers: Awaited<ReturnType<typeof loadMcpTools>> = [];
    if (!signal.aborted) {
      try {
        mcpServers = await loadMcpTools();
      } catch (error) {
        setWarning(t.aiMcpLoadFailed({ error: describeAssistantError(error) }));
      }
    }
    let skills: Awaited<ReturnType<typeof listSkills>> = [];
    if (!signal.aborted) {
      try {
        skills = await listSkills();
      } catch (error) {
        setWarning(t.aiSkillsLoadFailed({ error: describeAssistantError(error) }));
      }
    }
    const tools = createAssistantTools({
      document: editor
        ? {
            getEditor: options.getEditor,
            isDocxMode: options.isDocxMode,
            approval,
          }
        : null,
      includeDocumentWrites:
        !!editor && current.preferences.documentWriteEnabled && !options.isReadonly(),
      mcp:
        mcpServers.length > 0
          ? {
              servers: mcpServers,
              approval,
            }
          : null,
      // shell 的初始目录被限制在当前文档所在目录内；未保存文档没有工作区，不注入工具。
      shell:
        current.preferences.shellEnabled && documentPath
          ? {
              documentPath,
              labels: {
                title: t.aiShellApprovalTitle(),
                allow: t.aiShellAllow(),
                deny: t.aiShellDeny(),
              },
            }
          : null,
      skills: skills.length > 0,
      files: documentPath
        ? {
            getDocumentPath: options.getDocumentPath,
            approval,
          }
        : null,
      includeFileWrites:
        !!documentPath && current.preferences.fileWriteEnabled && !options.isReadonly(),
    });

    // 长对话先折叠再发请求：事后摘要对已经超窗的请求没有意义。
    // 摘要失败/中止都不会阻断本轮，最坏情况只是保留完整历史。
    let history = request.history;
    if (
      current.preferences.autoCompactionEnabled &&
      history.length > 0 &&
      !signal.aborted
    ) {
      try {
        const compacted = await compactHistory({
          history,
          previousSummary: summaryText,
          signal,
          generate: async (input, summarySignal) => {
            const result = await generateText({
              model: createAssistantModel(provider),
              system: SUMMARY_INSTRUCTION,
              prompt: input,
              abortSignal: summarySignal,
              maxOutputTokens: SUMMARY_OUTPUT_TOKENS,
            });
            return result.text;
          },
        });
        if (!signal.aborted) {
          history = compacted.history;
          modelHistory = history;
          summaryText = compacted.summary;
          setContext(history, compacted.degraded);
          if (compacted.summaryFailed) {
            setWarning(t.aiCompactionFailed());
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          setWarning(t.aiCompactionFailedDetail({ error: describeAssistantError(error) }));
        }
      }
    }

    const system = buildSystemPrompt({
      documentTitle: options.getDocumentTitle(),
      docxMode: options.isDocxMode(),
      hasDocumentTools: !!editor,
      hasWriteTools: Object.prototype.hasOwnProperty.call(tools, 'doc_apply_edit'),
      hasMcp: mcpServers.length > 0,
      hasShell: Object.prototype.hasOwnProperty.call(tools, 'shell_exec'),
      hasSkills: skills.length > 0,
      hasFileTools: !!documentPath,
      hasFileWrites: Object.prototype.hasOwnProperty.call(tools, 'file_write'),
      earlierSummary: summaryText,
    });

    // 回调在 await 之后才读，装进对象避免 TS 把变量收窄成 null。
    const turnResult: { error: string | null } = { error: null };
    try {
      if (signal.aborted) {
        // 等 MCP 连接时用户点了停止，这一轮不再发请求。
        patchAssistant((message) => ({ ...message, stopped: true }));
      } else {
        const result = await runAssistantTurn({
          provider,
          history,
          userText: request.userText,
          system,
          tools,
          signal,
          onTextDelta: (delta) => {
            patchAssistant((message) => ({ ...message, content: message.content + delta }));
          },
          onReasoningDelta: (delta) => {
            patchAssistant((message) => ({
              ...message,
              reasoning: (message.reasoning ?? '') + delta,
            }));
          },
          onToolCall: (call) => {
            // shell 的确认框由 Rust 原生对话框弹出，在结果回来前先显示「等待确认」。
            upsertToolCall(call, {
              status: call.name === 'shell_exec' ? 'pending-approval' : 'running',
              startedAt: Date.now(),
            });
          },
          onToolResult: (call) => {
            upsertToolCall(
              call,
              call.denied
                ? {
                    status: 'denied',
                    output: call.output,
                    error: call.reason,
                    finishedAt: Date.now(),
                  }
                : { status: 'success', output: call.output, finishedAt: Date.now() },
            );
          },
          onToolError: (call) => {
            upsertToolCall(call, {
              status: 'error',
              error: call.message,
              finishedAt: Date.now(),
            });
          },
          onError: (message) => {
            turnResult.error = message;
          },
        });

        modelHistory = [...history, ...result.messages];
        usage.value = result.usage;
        state.update((value) => ({ ...value, usage: result.usage }));
        setContext(modelHistory);

        if (result.aborted) {
          patchAssistant((message) => ({ ...message, stopped: true }));
        } else {
          const error = turnResult.error;
          if (error) {
            patchAssistant((message) => ({ ...message, error }));
          }
        }
      }
    } catch (error) {
      const message = signal.aborted ? t.aiStopped() : describeAssistantError(error);
      turnResult.error = message;
      patchAssistant((item) => ({ ...item, error: message }));
    } finally {
      streamingAssistantId = null;
      abortController = null;
      if (!disposed) {
        state.update((value) => ({ ...value, streaming: false }));
      }
    }

    if (!disposed) {
      const finished = snapshot().messages.find((message) => message.id === assistantMessage.id);
      if (finished) {
        const usageRecord = usage.value ? usageToRecord(usage.value) : null;
        if (request.mode === 'append') {
          const records: unknown[] = [
            messageToRecord(request.userMessage),
            messageToRecord(finished),
          ];
          if (usageRecord) records.push(usageRecord);
          await persistTurn('append', request.userMessage.content, records);
        } else {
          const records: unknown[] = [...request.visibleBefore, finished].map(messageToRecord);
          if (usageRecord) records.push(usageRecord);
          const titleSeed =
            [...request.visibleBefore, finished].find((message) => message.role === 'user')
              ?.content ?? request.userMessage.content;
          await persistTurn('sync', titleSeed, records);
        }
      }
    }
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (!content) {
      return;
    }
    // `/clear` 是命令而不是消息，不进入历史。
    if (content === '/clear') {
      newSession();
      return;
    }
    if (snapshot().streaming) {
      return;
    }

    const userMessage: AssistantMessage = {
      id: createMessageId(),
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    await executeTurn({
      userText: expand(content),
      userMessage,
      history: modelHistory,
      visibleBefore: [...snapshot().messages, userMessage],
      mode: 'append',
    });
  }

  async function regenerate(messageId: string): Promise<void> {
    const current = snapshot();
    if (current.streaming) {
      return;
    }
    const assistantIndex = current.messages.findIndex(
      (message) => message.id === messageId && message.role === 'assistant',
    );
    if (assistantIndex < 0) {
      return;
    }
    let userIndex = -1;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      if (current.messages[index]?.role === 'user') {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) {
      return;
    }
    const userMessage = current.messages[userIndex]!;
    const prior = current.messages.slice(0, userIndex);
    // 截断后的历史从可见消息重建；工具调用不重放，摘要也一并清空。
    modelHistory = toModelHistory(prior);
    summaryText = null;
    contextDegraded = false;
    setContext(modelHistory, false);
    await executeTurn({
      userText: expand(userMessage.content),
      userMessage,
      history: modelHistory,
      visibleBefore: current.messages.slice(0, userIndex + 1),
      mode: 'sync',
    });
  }

  async function editAndResend(messageId: string, text: string): Promise<void> {
    const current = snapshot();
    const content = text.trim();
    if (!content || current.streaming) {
      return;
    }
    const userIndex = current.messages.findIndex(
      (message) => message.id === messageId && message.role === 'user',
    );
    if (userIndex < 0) {
      return;
    }
    const prior = current.messages.slice(0, userIndex);
    const updated: AssistantMessage = {
      ...current.messages[userIndex]!,
      content,
      error: undefined,
      stopped: undefined,
      reasoning: undefined,
      toolCalls: undefined,
    };
    modelHistory = toModelHistory(prior);
    summaryText = null;
    contextDegraded = false;
    setContext(modelHistory, false);
    await executeTurn({
      userText: expand(content),
      userMessage: updated,
      history: modelHistory,
      visibleBefore: [...prior, updated],
      mode: 'sync',
    });
  }

  async function retry(messageId: string): Promise<void> {
    await regenerate(messageId);
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }
    try {
      const meta = await renameAssistantSession(id, trimmed);
      if (snapshot().sessionId === id) {
        sessionTitle = meta.title;
      }
      await refreshSessions();
    } catch (error) {
      state.update((value) => ({
        ...value,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function stop(): void {
    abortController?.abort();
    approval.cancelAll();
  }

  function clearWarning(): void {
    setWarning(null);
  }

  function decideApproval(decision: ApprovalDecision): void {
    const current = snapshot().approval;
    if (current) {
      approval.resolve(current.id, decision);
    }
  }

  function dispose(): void {
    disposed = true;
    abortController?.abort();
    approval.cancelAll();
    unsubscribeApproval();
  }

  return {
    state,
    initialize,
    reloadPreferences,
    setActiveProvider,
    send,
    regenerate,
    editAndResend,
    retry,
    stop,
    decideApproval,
    newSession,
    selectSession,
    removeSession,
    renameSession,
    refreshSessions,
    notify: setWarning,
    clearWarning,
    dispose,
  };
}
