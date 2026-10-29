<script lang="ts">
  import { Send, Square } from '@lucide/svelte';
  import { tick } from 'svelte';
  import type { SkillInfo } from '../../../lib/assistant/types';
  import { t } from '../../i18n';

  export let streaming = false;
  export let disabled = false;
  export let skills: SkillInfo[] = [];
  export let onSend: (text: string) => void;
  export let onStop: () => void;

  const MAX_SKILL_MATCHES = 8;

  interface ComposerMenuItem {
    key: string;
    label: string;
    description: string;
    /** 选中后填入输入框；`run` 用于立即执行的命令（如 /clear）。 */
    insert?: string;
    run?: () => void;
    /** 已经完整输入时，Enter 直接发送而不是再次插入。 */
    allowDirectSubmit?: boolean;
  }

  let text = '';
  let textarea: HTMLTextAreaElement | undefined;
  let selected = 0;
  let dismissed = false;

  // `/skill` 只在整段输入以命令开头时触发；`/skills` 之类不会误弹。
  $: skillQuery = /^\/skill(?:\s|$)/.test(text) ? text.replace(/^\/skill\s*/, '') : null;
  $: mentionQuery = /^@([^\s@]*)$/.test(text) ? text.slice(1) : null;
  $: commandQuery =
    skillQuery === null && /^\/[^\s]*$/.test(text) ? text.slice(1) : null;

  $: items = buildItems(skillQuery, mentionQuery, commandQuery);
  $: if (selected >= items.length) selected = 0;
  $: menuOpen = !dismissed && items.length > 0;

  function buildItems(
    skillQueryValue: string | null,
    mentionQueryValue: string | null,
    commandQueryValue: string | null,
  ): ComposerMenuItem[] {
    if (skillQueryValue !== null) {
      const query = skillQueryValue.trim().toLowerCase();
      return skills
        .filter(
          (skill) =>
            !query ||
            skill.id.toLowerCase().includes(query) ||
            skill.name.toLowerCase().includes(query),
        )
        .slice(0, MAX_SKILL_MATCHES)
        .map((skill) => ({
          key: `skill:${skill.id}`,
          label: skill.id,
          description: skill.description || skill.name,
          insert: `/skill ${skill.id} `,
        }));
    }
    if (mentionQueryValue !== null) {
      const query = mentionQueryValue.trim().toLowerCase();
      const mentions: ComposerMenuItem[] = [
        {
          key: 'mention:document',
          label: t.aiMentionDoc(),
          description: t.aiMentionDocDesc(),
          insert: `${t.aiMentionDoc()} `,
          allowDirectSubmit: true,
        },
        {
          key: 'mention:selection',
          label: t.aiMentionSelection(),
          description: t.aiMentionSelectionDesc(),
          insert: `${t.aiMentionSelection()} `,
          allowDirectSubmit: true,
        },
      ];
      return mentions.filter(
        (item) =>
          !query ||
          item.label.toLowerCase().includes(query) ||
          (query === 'doc' && item.key === 'mention:document') ||
          (query === 'selection' && item.key === 'mention:selection'),
      );
    }
    if (commandQueryValue !== null) {
      const query = commandQueryValue.toLowerCase();
      const commands: ComposerMenuItem[] = [
        {
          key: 'command:clear',
          label: '/clear',
          description: t.aiCommandClearDesc(),
          run: () => submitText('/clear'),
        },
        {
          key: 'command:skill',
          label: '/skill',
          description: t.aiCommandSkillDesc(),
          insert: '/skill ',
        },
      ];
      return commands.filter((item) => !query || item.label.slice(1).startsWith(query));
    }
    return [];
  }

  function submit(): void {
    submitText(text);
  }

  function submitText(value: string): void {
    const content = value.trim();
    if (!content || disabled || streaming) {
      return;
    }
    text = '';
    dismissed = false;
    resize();
    onSend(content);
  }

  function applyItem(item: ComposerMenuItem): void {
    if (item.run) {
      dismissed = false;
      selected = 0;
      item.run();
      return;
    }
    text = item.insert ?? '';
    dismissed = false;
    selected = 0;
    void tick().then(() => {
      textarea?.focus();
      resize();
    });
  }

  function handleInput(): void {
    dismissed = false;
    resize();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selected = (selected + 1) % items.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        selected = (selected - 1 + items.length) % items.length;
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissed = true;
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        const item = items[selected];
        if (!item) {
          return;
        }
        // 完整输入的 @文档 / @选区 直接作为消息发送，不再二次插入。
        if (item.allowDirectSubmit && text.trim() === item.insert?.trim()) {
          submit();
          return;
        }
        applyItem(item);
        return;
      }
    }
    // 输入法组字时的 Enter 不能当作发送。
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function resize(): void {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 72), 220)}px`;
  }
</script>

<div class="ai-composer">
  {#if menuOpen}
    <ul class="ai-skill-menu" role="listbox" aria-label={t.aiCommandMenuLabel()}>
      {#each items as item, index (item.key)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === selected}
            class:active={index === selected}
            on:mousedown={(event) => {
              event.preventDefault();
              applyItem(item);
            }}
          >
            <span class="ai-skill-id">{item.label}</span>
            <span class="ai-skill-desc">{item.description}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <textarea
    bind:this={textarea}
    bind:value={text}
    rows="3"
    placeholder={t.aiInputPlaceholder()}
    {disabled}
    on:input={handleInput}
    on:keydown={handleKeydown}
  ></textarea>
  {#if streaming}
    <button
      type="button"
      class="ai-icon-button ai-stop-button"
      title={t.aiStop()}
      on:click={onStop}
    >
      <Square size={13} />
    </button>
  {:else}
    <button
      type="button"
      class="ai-send-button"
      title={t.aiSend()}
      disabled={disabled || !text.trim()}
      on:click={submit}
    >
      <Send size={14} />
    </button>
  {/if}
</div>
