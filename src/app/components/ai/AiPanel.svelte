<script lang="ts">
  import { Download, History, Plus, Sparkles, X } from '@lucide/svelte';
  import { onDestroy, onMount, tick } from 'svelte';
  import type { EditorCore } from '../../../lib/editor-core/types';
  import { exportAssistantSession } from '../../../lib/assistant/sessions';
  import { listSkills } from '../../../lib/assistant/skills';
  import type { SkillInfo } from '../../../lib/assistant/types';
  import {
    AI_DRAWER_DEFAULT_WIDTH,
    AI_DRAWER_MAX_WIDTH,
    AI_DRAWER_MIN_WIDTH,
    applyAiDrawerWidth,
    clampAiDrawerWidth,
    readStoredAiDrawerWidth,
    writeStoredAiDrawerWidth,
  } from '../../../lib/layout/aiDrawerWidth';
  import { t } from '../../i18n';
  import { createAiController, type AiPanelState } from '../../services/aiController';
  import AiApprovalCard from './AiApprovalCard.svelte';
  import AiComposer from './AiComposer.svelte';
  import AiMessage from './AiMessage.svelte';
  import AiSessionList from './AiSessionList.svelte';

  export let core: EditorCore;
  export let docxMode = false;
  export let readonly = false;
  export let fileName = '';
  /** 当前文档的绝对路径；未保存时为空，文件工具不会注入。 */
  export let documentPath: string | null = null;
  export let onClose: () => void = () => undefined;
  export let openSettings: (category?: string) => void = () => undefined;
  /** 把流式状态告诉上层：工具栏/快捷键关闭面板前需要确认。 */
  export let onStreamingChange: (streaming: boolean) => void = () => undefined;

  const controller = createAiController({
    getEditor: () => core ?? null,
    isDocxMode: () => docxMode,
    getDocumentTitle: () => fileName || null,
    isReadonly: () => readonly,
    getDocumentPath: () => documentPath || null,
    getSelectionText: () => core?.getClipboardPayload()?.text ?? null,
  });
  const aiState = controller.state;

  let sessionsOpen = false;
  let panelEl: HTMLElement | undefined;
  let messagesEl: HTMLDivElement | undefined;
  // 抽屉宽度：null 表示沿用 CSS 的默认宽度（随容器收缩）。
  let drawerWidth: number | null = readStoredAiDrawerWidth();
  let resizePointerId: number | null = null;
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  $: applyAiDrawerWidth(drawerWidth);
  let lastMessageCount = -1;
  let lastStreamingLength = -1;
  let skills: SkillInfo[] = [];
  let exporting = false;

  /** 技能目录可能随时新增/修改；失败时只隐藏补全，不打断对话。 */
  async function loadSkills(): Promise<void> {
    try {
      skills = await listSkills();
    } catch {
      skills = [];
    }
  }

  // 设置是独立窗口；关闭后主窗口重新获得焦点，借此刷新服务商、Key 与技能列表。
  function handleWindowFocus(): void {
    if (!document.hidden) {
      void controller.reloadPreferences();
      void loadSkills();
    }
  }

  onMount(() => {
    void controller.initialize();
    void loadSkills();
    window.addEventListener('focus', handleWindowFocus);
  });

  onDestroy(() => {
    window.removeEventListener('focus', handleWindowFocus);
    onStreamingChange(false);
    controller.dispose();
  });

  // 新消息或流式增量到达时贴到底部；用户往上翻时不强制拉回。
  $: if (
    $aiState.messages.length !== lastMessageCount ||
    streamLength($aiState) !== lastStreamingLength
  ) {
    lastMessageCount = $aiState.messages.length;
    lastStreamingLength = streamLength($aiState);
    void scrollToBottom();
  }

  function streamLength(state: AiPanelState): number {
    const last = state.messages[state.messages.length - 1];
    return last ? last.content.length : 0;
  }

  async function scrollToBottom(): Promise<void> {
    await tick();
    if (!messagesEl) return;
    const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    // 超过一屏时只在接近底部才跟随，避免打断阅读历史。
    if (distance < 160) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function handleProviderChange(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value) {
      void controller.setActiveProvider(value);
    }
  }

  function handleSelectSession(id: string): void {
    sessionsOpen = false;
    void controller.selectSession(id);
  }

  function handleDeleteSession(id: string): void {
    if (!window.confirm(t.aiDeleteSessionConfirm())) {
      return;
    }
    void controller.removeSession(id);
  }

  function handleRenameSession(id: string, title: string): void {
    void controller.renameSession(id, title);
  }

  function safeFileStem(value: string): string {
    const cleaned = value
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return cleaned || 'nomo-chat';
  }

  async function handleExport(): Promise<void> {
    if (exporting || $aiState.messages.length === 0) {
      return;
    }
    const title =
      $aiState.sessions.find((session) => session.id === $aiState.sessionId)?.title ||
      $aiState.messages.find((message) => message.role === 'user')?.content ||
      'nomo-chat';
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        defaultPath: `${safeFileStem(title)}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'JSONL', extensions: ['jsonl'] },
        ],
      });
      if (!path) {
        return;
      }
      exporting = true;
      const format = path.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'markdown';
      const result = await exportAssistantSession($aiState.sessionId, path, format);
      controller.notify(t.aiExportDone({ path: result.path }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller.notify(t.aiExportFailed({ error: message }));
    } finally {
      exporting = false;
    }
  }

  function handleClose(): void {
    if ($aiState.streaming && !window.confirm(t.aiCloseWhileStreaming())) {
      return;
    }
    onClose();
  }

  function openAiSettings(): void {
    openSettings('ai');
  }

  function currentDrawerWidth(): number {
    return panelEl?.getBoundingClientRect().width ?? drawerWidth ?? AI_DRAWER_DEFAULT_WIDTH;
  }

  /** 抽屉再宽也要给正文留出可读宽度；卡片很窄时以最小宽度为准。 */
  function maxDrawerWidth(): number {
    const cardWidth = panelEl?.parentElement?.getBoundingClientRect().width ?? 0;
    if (cardWidth <= 0) return AI_DRAWER_MAX_WIDTH;
    return Math.max(AI_DRAWER_MIN_WIDTH, Math.min(AI_DRAWER_MAX_WIDTH, Math.round(cardWidth - 420)));
  }

  function setDrawerWidth(next: number): void {
    drawerWidth = Math.min(clampAiDrawerWidth(next), maxDrawerWidth());
  }

  function handleResizeStart(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return;
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = currentDrawerWidth();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleResizeMove(event: PointerEvent): void {
    if (resizePointerId !== event.pointerId) return;
    // 抽屉贴在右侧：指针向左移动（clientX 变小）时变宽。
    setDrawerWidth(resizeStartWidth + (resizeStartX - event.clientX));
  }

  function endResize(event: PointerEvent): void {
    if (resizePointerId !== event.pointerId) return;
    resizePointerId = null;
    writeStoredAiDrawerWidth(drawerWidth);
  }

  function resetDrawerWidth(event: MouseEvent): void {
    event.preventDefault();
    drawerWidth = null;
    writeStoredAiDrawerWidth(null);
  }

  function handleResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = currentDrawerWidth() + step;
    else if (event.key === 'ArrowRight') next = currentDrawerWidth() - step;
    else if (event.key === 'Home') next = AI_DRAWER_MIN_WIDTH;
    else if (event.key === 'End') next = maxDrawerWidth();
    if (next == null) return;
    event.preventDefault();
    setDrawerWidth(next);
    writeStoredAiDrawerWidth(drawerWidth);
  }

  $: onStreamingChange($aiState.streaming);
  $: providers = $aiState.preferences.providers;
  $: activeProviderHasKey = $aiState.providersWithKey.includes(
    $aiState.preferences.activeProviderId,
  );
  // 没有保存密钥时直接禁用输入，避免用户写完一整段才在发送时收到错误。
  $: canSend = providers.length > 0 && activeProviderHasKey;
  $: lastMessage = $aiState.messages[$aiState.messages.length - 1];
  $: pendingAssistant =
    $aiState.streaming &&
    lastMessage?.role === 'assistant' &&
    !lastMessage.content &&
    (lastMessage.toolCalls?.length ?? 0) === 0;
</script>

<aside class="ai-panel" aria-label={t.aiAssistant()} bind:this={panelEl}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="ai-drawer-resizer"
    class:resizing={resizePointerId !== null}
    role="separator"
    aria-orientation="vertical"
    aria-label={t.resizeAiDrawer()}
    aria-valuemin={AI_DRAWER_MIN_WIDTH}
    aria-valuemax={maxDrawerWidth()}
    aria-valuenow={Math.round(drawerWidth ?? currentDrawerWidth())}
    tabindex="0"
    title={t.resizeAiDrawer()}
    on:pointerdown={handleResizeStart}
    on:pointermove={handleResizeMove}
    on:pointerup={endResize}
    on:pointercancel={endResize}
    on:dblclick={resetDrawerWidth}
    on:keydown={handleResizeKeydown}
  ></div>
  <header class="ai-panel-header">
    <div class="ai-panel-heading">
      <Sparkles size={15} />
      <strong>{t.aiAssistant()}</strong>
    </div>
    <div class="ai-panel-actions">
      {#if providers.length > 0}
        <select
          class="ai-provider-select"
          value={$aiState.preferences.activeProviderId}
          title={t.aiProvider()}
          on:change={handleProviderChange}
        >
          {#each providers as provider (provider.id)}
            <option value={provider.id}>{provider.name}</option>
          {/each}
        </select>
      {/if}
      <button
        type="button"
        class="ai-icon-button"
        title={t.aiNewChat()}
        on:click={() => controller.newSession()}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        class="ai-icon-button"
        class:active={sessionsOpen}
        title={t.aiSessions()}
        on:click={() => (sessionsOpen = !sessionsOpen)}
      >
        <History size={15} />
      </button>
      <button
        type="button"
        class="ai-icon-button"
        title={t.aiExportSession()}
        disabled={exporting || $aiState.messages.length === 0}
        on:click={() => void handleExport()}
      >
        <Download size={15} />
      </button>
      <button type="button" class="ai-icon-button" title={t.close()} on:click={handleClose}>
        <X size={15} />
      </button>
    </div>
  </header>

  {#if sessionsOpen}
    <AiSessionList
      sessions={$aiState.sessions}
      activeId={$aiState.sessionId}
      onSelect={handleSelectSession}
      onDelete={handleDeleteSession}
      onRename={handleRenameSession}
      onClose={() => (sessionsOpen = false)}
    />
  {/if}

  <div class="ai-panel-messages" bind:this={messagesEl}>
    {#if $aiState.loading}
      <p class="ai-panel-hint">{t.aiLoading()}</p>
    {:else if !canSend}
      <div class="ai-panel-empty">
        <p>{providers.length === 0 ? t.aiEmptyNoProvider() : t.aiNoKeyHint()}</p>
        <button type="button" class="ai-primary-button" on:click={openAiSettings}>
          {t.aiOpenSettings()}
        </button>
      </div>
    {:else if $aiState.messages.length === 0}
      <div class="ai-panel-empty">
        <p>{t.aiEmptyIntro()}</p>
        <ul>
          <li>{t.aiEmptySuggestionRead()}</li>
          <li>{t.aiEmptySuggestionEdit()}</li>
          <li>{t.aiEmptySuggestionProofread()}</li>
        </ul>
      </div>
    {:else}
      {#each $aiState.messages as message (message.id)}
        <AiMessage
          {message}
          pending={pendingAssistant && message.id === lastMessage?.id}
          busy={$aiState.streaming}
          onRegenerate={(id) => void controller.regenerate(id)}
          onEditResend={(id, text) => void controller.editAndResend(id, text)}
        />
      {/each}
    {/if}

    {#if $aiState.error}
      <div class="ai-panel-error" role="alert">{$aiState.error}</div>
    {/if}

    {#if $aiState.warning}
      <div class="ai-panel-warning" role="status">
        <span>{$aiState.warning}</span>
        <button
          type="button"
          class="ai-icon-button"
          title={t.close()}
          on:click={() => controller.clearWarning()}
        >
          <X size={13} />
        </button>
      </div>
    {/if}
  </div>

  {#if $aiState.approval}
    <AiApprovalCard
      request={$aiState.approval}
      onDecide={(decision) => controller.decideApproval(decision)}
    />
  {/if}

  <AiComposer
    streaming={$aiState.streaming}
    disabled={!canSend}
    {skills}
    onSend={(text) => void controller.send(text)}
    onStop={() => controller.stop()}
  />

  {#if (($aiState.usage?.totalTokens ?? 0) > 0) || $aiState.context.used > 0}
    <footer class="ai-panel-footer">
      {#if ($aiState.usage?.totalTokens ?? 0) > 0}
        {#if $aiState.usage?.inputTokens || $aiState.usage?.outputTokens}
          {t.aiTokenUsageDetail({
            input: String($aiState.usage?.inputTokens ?? 0),
            output: String($aiState.usage?.outputTokens ?? 0),
          })}
        {:else}
          {t.aiTokenUsage({ count: String($aiState.usage?.totalTokens ?? 0) })}
        {/if}
      {/if}
      {#if $aiState.context.used > 0}
        <span class="ai-context-usage">
          {t.aiContextUsage({
            used: String($aiState.context.used),
            budget: String($aiState.context.budget),
          })}{$aiState.context.summaryActive ? ` · ${t.aiContextSummarized()}` : ''}{$aiState
            .context.degraded
            ? ` · ${t.aiContextDegraded()}`
            : ''}
        </span>
      {/if}
    </footer>
  {/if}
</aside>
