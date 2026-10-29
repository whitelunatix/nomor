<script lang="ts">
  import { BookOpenText, CodeXml, Columns2 } from '@lucide/svelte';
  import type { EditorViewMode } from '../types';
  import { modeSwitchIndicator } from '../actions/motion';
  import { t } from '../i18n';

  export let mode: EditorViewMode;
  export let setMode: (mode: EditorViewMode) => void;
  export let splitModeDisabled = false;
  export let largeDocumentMode = false;
</script>

<!--
  语义 / 源码 / 双栏三种编辑模式放在正文左下角（Typora 式浮动胶囊），
  工具栏只保留编辑与视图操作，阅读时视线不必回到顶部。
-->
<div class="editor-mode-dock">
  <div
    class="mode-switch"
    class:two-modes={splitModeDisabled}
    aria-label={t.mode()}
    use:modeSwitchIndicator={{ mode }}
  >
    <button
      title={largeDocumentMode ? t.largeDocumentStayReadonlySource() : t.semanticEditingTitle()}
      aria-label={t.semanticEditing()}
      aria-pressed={mode === 'semantic'}
      class:active={mode === 'semantic'}
      disabled={largeDocumentMode}
      on:click={() => setMode('semantic')}
    >
      <BookOpenText size={17} />
    </button>
    <button
      title={t.sourceModeTitle()}
      aria-label={t.sourceMode()}
      aria-pressed={mode === 'source'}
      class:active={mode === 'source'}
      on:click={() => setMode('source')}
    >
      <CodeXml size={17} />
    </button>
    {#if !splitModeDisabled}
      <button
        title={largeDocumentMode ? t.largeDocumentStayReadonlySource() : t.splitMode()}
        aria-label={t.splitMode()}
        aria-pressed={mode === 'split'}
        class:active={mode === 'split'}
        disabled={largeDocumentMode}
        on:click={() => setMode('split')}
      >
        <Columns2 size={17} />
      </button>
    {/if}
  </div>
</div>

<style>
  /* 挂在 .workspace 左下角，正好位于文件树栏下方、与右下角状态栏同一行。 */
  .editor-mode-dock {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 60;
    display: inline-flex;
    pointer-events: auto;
  }

  .editor-mode-dock :global(.mode-switch) {
    box-shadow: var(--md-editor-shadow-raised);
    backdrop-filter: blur(10px);
  }

  @media (max-width: 720px) {
    .editor-mode-dock {
      left: 8px;
      bottom: 8px;
    }
  }
</style>
