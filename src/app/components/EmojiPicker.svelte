<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { X, Search } from '@lucide/svelte';
  import { loadEmojiCatalog } from '../services/emojiCatalog';
  import { EMOJI_GROUPS, searchEmoji, type EmojiEntry } from '../../lib/emoji/catalog';
  import { EMOJI_TRANSLATIONS } from '../i18n.emoji';

  export let interfaceLocale: string;
  export let anchor: { left: number; top: number; bottom: number };
  export let onChoose: (entry: EmojiEntry) => void;
  export let onClose: () => void;
  let catalog: readonly EmojiEntry[] = [];
  let query = '';
  let group: number | undefined = undefined;
  let loading = true;
  let failed = false;
  let selected = 0;
  let scrollTop = 0;
  let left = 8;
  let top = 8;
  let generation = 0;
  let dead = false;
  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let grid: HTMLDivElement;
  const columns = 8;
  const rowHeight = 40;
  const viewportHeight = 240;
  $: results = searchEmoji(catalog, query, group);
  $: rows = Math.ceil(results.length / columns);
  $: firstRow = Math.max(0, Math.min(Math.floor(scrollTop / rowHeight) - 2, Math.max(0, rows - 1)));
  $: visible = results.slice(firstRow * columns, (firstRow + 10) * columns);
  $: chinese = interfaceLocale.startsWith('zh');
  $: labels = EMOJI_TRANSLATIONS[interfaceLocale] ?? EMOJI_TRANSLATIONS['en-US'];
  $: if (query !== undefined && group !== null) resetSelection(query, group);

  function resetSelection(_query: string, _group: number | undefined) {
    selected = 0;
    scrollTop = 0;
    if (grid) grid.scrollTop = 0;
  }

  async function load(retry = false) {
    const request = ++generation;
    loading = true;
    failed = false;
    try {
      const data = await loadEmojiCatalog(retry);
      if (dead || request !== generation) return;
      catalog = data;
    } catch {
      if (!dead && request === generation) failed = true;
    } finally {
      if (!dead && request === generation) {
        loading = false;
        await tick();
        position();
      }
    }
  }

  function position() {
    if (!root) return;
    const box = root.getBoundingClientRect();
    left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8));
    top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8));
  }

  function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const inSearch = event.target === input;
    const inGrid = event.target instanceof Element && grid?.contains(event.target);
    if (!results.length || (!inSearch && !inGrid) || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const delta =
      event.key === 'ArrowDown'
        ? columns
        : event.key === 'ArrowUp'
          ? -columns
          : inGrid && event.key === 'ArrowRight'
            ? 1
            : inGrid && event.key === 'ArrowLeft'
              ? -1
              : 0;
    if (delta) {
      event.preventDefault();
      selected = Math.max(
        0,
        Math.min(
          results.length - 1,
          selected + (inSearch && event.key === 'ArrowDown' ? 0 : delta),
        ),
      );
      const y = Math.floor(selected / columns) * rowHeight;
      if (y < grid.scrollTop) grid.scrollTop = y;
      else if (y + rowHeight > grid.scrollTop + viewportHeight)
        grid.scrollTop = y + rowHeight - viewportHeight;
      scrollTop = grid.scrollTop;
      void tick().then(() =>
        grid?.querySelector<HTMLButtonElement>(`[data-index="${selected}"]`)?.focus(),
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onChoose(results[selected]);
    }
  }

  function outside(event: PointerEvent) {
    if (event.target instanceof Element && event.target.closest('[data-emoji-trigger]')) return;
    if (event.target instanceof Node && !root?.contains(event.target)) onClose();
  }

  onMount(() => {
    position();
    input.focus();
    void load();
  });
  onDestroy(() => {
    dead = true;
    generation++;
  });
</script>

<svelte:window on:resize={position} on:pointerdown={outside} />
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="emoji-picker"
  role="dialog"
  aria-label={labels.emojiInsert}
  style:left={`${left}px`}
  style:top={`${top}px`}
  on:keydown={keydown}
  tabindex="-1"
>
  <div class="emoji-picker-header">
    <strong>{labels.emojiInsert}</strong><button
      type="button"
      aria-label={labels.emojiClose}
      on:click={onClose}><X size={16} /></button
    >
  </div>
  <label class="emoji-search"
    ><Search size={15} /><input
      bind:this={input}
      bind:value={query}
      aria-label={labels.emojiSearch}
      placeholder={labels.emojiSearch}
    /></label
  >
  <div class="emoji-categories" aria-label={labels.emojiAll}>
    <button
      type="button"
      class:active={group === undefined}
      aria-pressed={group === undefined}
      on:click={() => (group = undefined)}>{labels.emojiAll}</button
    >
    {#each EMOJI_GROUPS as category}<button
        type="button"
        class:active={group === category}
        aria-pressed={group === category}
        on:click={() => (group = category)}>{labels[`emojiGroup${category}`]}</button
      >{/each}
  </div>
  {#if loading}<div class="emoji-status" role="status">{labels.emojiLoading}</div>
  {:else if failed}<div class="emoji-status" role="status">
      {labels.emojiLoadFailed}<button type="button" on:click={() => load(true)}
        >{labels.emojiRetry}</button
      >
    </div>
  {:else if !results.length}<div class="emoji-status" role="status">{labels.emojiNoResults}</div>
  {:else}
    <div
      bind:this={grid}
      class="emoji-grid"
      role="group"
      aria-label={labels.emojiSuggestions}
      on:scroll={() => (scrollTop = grid.scrollTop)}
    >
      <div class="emoji-grid-space" style:height={`${rows * rowHeight}px`}>
        <div class="emoji-grid-window" style:top={`${firstRow * rowHeight}px`}>
          {#each visible as entry, offset (entry.id)}
            {@const index = firstRow * columns + offset}
            <button
              type="button"
              class:active={selected === index}
              class="emoji-glyph"
              data-index={index}
              tabindex={selected === index ? 0 : -1}
              aria-label={`${chinese ? entry.zh : entry.en} :${entry.shortcodes[0]}:`}
              title={`${chinese ? entry.zh : entry.en} · :${entry.shortcodes[0]}:`}
              on:focus={() => (selected = index)}
              on:click={() => onChoose(entry)}>{entry.unicode}</button
            >
          {/each}
        </div>
      </div>
    </div>
    <div class="emoji-picker-footer">
      {results[selected] ? (chinese ? results[selected].zh : results[selected].en) : ''}<small
        >{results[selected] ? `:${results[selected].shortcodes[0]}:` : ''}</small
      >
    </div>
  {/if}
</div>
