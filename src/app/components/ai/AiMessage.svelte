<script lang="ts">
  import { Check, Copy, Pencil, RotateCcw } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { AssistantMessage } from '../../../lib/assistant/types';
  import { renderAssistantMarkdown } from '../../../lib/assistant/markdown';
  import { t } from '../../i18n';
  import AiToolCard from './AiToolCard.svelte';

  export let message: AssistantMessage;
  /** 正在流式输出且还没有任何内容时显示等待提示。 */
  export let pending = false;
  /** 流式期间禁用所有会改写会话的操作。 */
  export let busy = false;
  export let onRegenerate: (id: string) => void = () => undefined;
  export let onEditResend: (id: string, text: string) => void = () => undefined;

  let copied = false;
  let editing = false;
  let draft = '';
  let editArea: HTMLTextAreaElement | undefined;

  $: html = message.role === 'assistant' ? renderAssistantMarkdown(message.content) : '';
  $: hasToolCalls = (message.toolCalls?.length ?? 0) > 0;

  async function copyText(value: string): Promise<void> {
    if (!value) {
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(value);
      }
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1200);
    } catch {
      // 剪贴板失败不影响对话，按钮保持原状即可。
    }
  }

  function copyMessage(): void {
    void copyText(message.content);
  }

  // 代码块由 markdown 渲染器生成按钮，这里统一代理点击。
  function handleContentClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest('.ai-code-copy');
    if (!(button instanceof HTMLElement)) {
      return;
    }
    const code = button.closest('.ai-code-block')?.querySelector('code');
    if (!code) {
      return;
    }
    void copyText(code.textContent ?? '');
    button.textContent = t.aiCopied();
    setTimeout(() => {
      button.textContent = t.aiCodeCopy();
    }, 1200);
  }

  function startEdit(): void {
    draft = message.content;
    editing = true;
    void tick().then(() => {
      editArea?.focus();
      editArea?.setSelectionRange(draft.length, draft.length);
    });
  }

  function cancelEdit(): void {
    editing = false;
    draft = '';
  }

  function saveEdit(): void {
    const value = draft.trim();
    if (!value) {
      return;
    }
    editing = false;
    onEditResend(message.id, value);
  }
</script>

<article
  class="ai-message"
  class:user={message.role === 'user'}
  class:assistant={message.role === 'assistant'}
>
  <div class="ai-message-body">
    {#if message.role === 'user'}
      {#if editing}
        <div class="ai-message-editor">
          <textarea bind:this={editArea} bind:value={draft} rows="3"></textarea>
          <div class="ai-message-editor-actions">
            <button type="button" class="ai-secondary-button" on:click={cancelEdit}>
              {t.aiEditCancel()}
            </button>
            <button
              type="button"
              class="ai-primary-button"
              disabled={busy || !draft.trim()}
              on:click={saveEdit}
            >
              {t.aiEditSave()}
            </button>
          </div>
        </div>
      {:else}
        <p class="ai-message-text">{message.content}</p>
      {/if}
    {:else}
      {#if message.reasoning}
        <details class="ai-message-reasoning">
          <summary>{t.aiReasoning()}</summary>
          <p>{message.reasoning}</p>
        </details>
      {/if}
      {#if hasToolCalls}
        <div class="ai-message-tools">
          {#each message.toolCalls ?? [] as tool (tool.id)}
            <AiToolCard {tool} />
          {/each}
        </div>
      {/if}
      {#if message.content}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="ai-message-content" on:click={handleContentClick}>{@html html}</div>
      {:else if pending}
        <p class="ai-message-waiting" aria-live="polite">
          <span></span><span></span><span></span>
        </p>
      {/if}
      {#if message.error}
        <p class="ai-message-error" role="alert">{message.error}</p>
      {:else if message.stopped}
        <p class="ai-message-stopped">{t.aiStopped()}</p>
      {/if}
    {/if}
  </div>

  {#if !editing && !pending}
    <div class="ai-message-actions">
      {#if message.role === 'user'}
        <button
          type="button"
          class="ai-message-action"
          title={t.aiEditResend()}
          disabled={busy}
          on:click={startEdit}
        >
          <Pencil size={12} />
        </button>
      {:else}
        <button
          type="button"
          class="ai-message-action"
          title={message.error ? t.aiRetry() : t.aiRegenerate()}
          disabled={busy}
          on:click={() => onRegenerate(message.id)}
        >
          <RotateCcw size={12} />
        </button>
      {/if}
      <button
        type="button"
        class="ai-message-action"
        title={copied ? t.aiCopied() : t.aiMessageCopy()}
        on:click={copyMessage}
      >
        {#if copied}
          <Check size={12} />
        {:else}
          <Copy size={12} />
        {/if}
      </button>
    </div>
  {/if}
</article>
