<script lang="ts">
  import { Check, Pencil, Trash2, X } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { AssistantSessionSummary } from '../../../lib/assistant/types';
  import { t } from '../../i18n';

  export let sessions: AssistantSessionSummary[];
  export let activeId: string;
  export let onSelect: (id: string) => void;
  export let onDelete: (id: string) => void;
  export let onRename: (id: string, title: string) => void;
  export let onClose: () => void;

  let renamingId: string | null = null;
  let renameDraft = '';
  let renameInput: HTMLInputElement | undefined;

  /** Rust 侧时间戳是秒，前端消息是毫秒；这里按秒处理。 */
  function formatTime(seconds: number): string {
    if (!seconds) return '';
    const date = new Date(seconds * 1000);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  }

  function startRename(session: AssistantSessionSummary): void {
    renamingId = session.id;
    renameDraft = session.title;
    void tick().then(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  function cancelRename(): void {
    renamingId = null;
    renameDraft = '';
  }

  function saveRename(): void {
    const id = renamingId;
    const title = renameDraft.trim();
    if (!id || !title) {
      return;
    }
    renamingId = null;
    renameDraft = '';
    onRename(id, title);
  }

  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }
</script>

<div class="ai-session-list">
  <header>
    <strong>{t.aiSessions()}</strong>
    <button type="button" class="ai-icon-button" title={t.close()} on:click={onClose}>
      <X size={13} />
    </button>
  </header>
  {#if sessions.length === 0}
    <p class="ai-session-empty">{t.aiNoSessions()}</p>
  {:else}
    <ul>
      {#each sessions as session (session.id)}
        <li class:active={session.id === activeId}>
          {#if renamingId === session.id}
            <div class="ai-session-rename">
              <input
                bind:this={renameInput}
                bind:value={renameDraft}
                maxlength="120"
                aria-label={t.aiRenameSession()}
                on:keydown={handleRenameKeydown}
              />
              <button
                type="button"
                class="ai-icon-button"
                title={t.aiEditSave()}
                disabled={!renameDraft.trim()}
                on:click={saveRename}
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                class="ai-icon-button"
                title={t.aiEditCancel()}
                on:click={cancelRename}
              >
                <X size={13} />
              </button>
            </div>
          {:else}
            <button type="button" class="ai-session-open" on:click={() => onSelect(session.id)}>
              <span class="ai-session-title">{session.title || t.aiSessionUntitled()}</span>
              <span class="ai-session-time">{formatTime(session.updatedAt)}</span>
            </button>
            <button
              type="button"
              class="ai-icon-button ai-session-rename-button"
              title={t.aiRenameSession()}
              on:click={() => startRename(session)}
            >
              <Pencil size={12} />
            </button>
            <button
              type="button"
              class="ai-icon-button ai-session-delete"
              title={t.aiDeleteSession()}
              on:click={() => onDelete(session.id)}
            >
              <Trash2 size={13} />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
