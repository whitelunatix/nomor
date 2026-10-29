<script lang="ts">
  import {
    AlignHorizontalSpaceAround,
    Bold,
    Braces,
    CheckSquare,
    ChevronUp,
    PanelTopClose,
    Code2,
    Heading1,
    Highlighter,
    Italic,
    Link,
    List,
    ListTree,
    MessageSquare,
    Info,
    Paintbrush,
    Quote,
    Search,
    Sigma,
    SlidersHorizontal,
    Sparkles,
    Strikethrough,
    Superscript,
    Subscript,
    Table2,
    TableOfContents,
    Underline,
  } from '@lucide/svelte';
  import {
    DIAGRAM_TEMPLATES,
    type DiagramType,
    type EditorCommand,
    type InlinePendingMarks,
  } from '../../lib/editor-core';
  import type { EditorViewMode } from '../types';
  import { clickOutside } from '../actions/clickOutside';
  import { typographyRange } from '../actions/typographyRange';
  import { getDiagramTypeLabel, t } from '../i18n';

  export let interfaceLocale: string;
  export let mode: EditorViewMode;
  export let contentWidthPercent: number;
  export let outlineVisible: boolean;
  /** `.docx.md` 专用模式：只有该模式显示属性面板按钮。 */
  export let docxMode = false;
  export let docxInspectorVisible = false;
  export let toggleDocxInspector: () => void = () => undefined;
  /** AI 助手面板开关；未配置服务商时也可以打开面板。 */
  export let aiPanelVisible = false;
  export let toggleAiPanel: () => void = () => undefined;
  export let toolbarShortcut: string;
  export let runCommand: (command: EditorCommand) => void;
  export let pendingInlineMarks: InlinePendingMarks;
  export let formatPainterActive = false;
  export let toggleFormatPainter: () => void = () => undefined;
  export let tablePickerOpen: boolean;
  export let openTablePicker: () => void;
  export let closeTablePicker: () => void;
  export let openLinkPicker: () => void;
  export let insertTableWithSize: (rows: number, columns: number) => void;
  export let updateContentWidth: (event: Event) => void;
  export let toggleOutlineVisible: () => void;
  export let toggleToolbar: () => void;
  export let inactive = false;
  export let openSearchPanel: () => void;
  export let mathInlineInsertionDisabled = true;

  const tableRows = [1, 2, 3, 4, 5];
  const tableColumns = [1, 2, 3, 4, 5, 6];
  let previewRows = 3;
  let previewColumns = 4;
  let diagramPickerOpen = false;
  let widthPickerOpen = false;
  let mathPickerOpen = false;

  function trackToolbarScroll(node: HTMLElement) {
    let frameId: number | null = null;

    const update = () => {
      frameId = null;
      const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
      node.classList.toggle('can-scroll-left', node.scrollLeft > 1);
      node.classList.toggle('can-scroll-right', maxScrollLeft - node.scrollLeft > 1);
    };

    const scheduleUpdate = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(update);
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(node);
    node.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    scheduleUpdate();

    return {
      destroy() {
        if (frameId !== null) {
          window.cancelAnimationFrame(frameId);
        }
        resizeObserver?.disconnect();
        node.removeEventListener('scroll', scheduleUpdate);
        window.removeEventListener('resize', scheduleUpdate);
      },
    };
  }

  $: if (inactive) {
    mathPickerOpen = false;
    diagramPickerOpen = false;
    widthPickerOpen = false;
  }

  function toggleTablePicker() {
    if (tablePickerOpen) {
      closeTablePicker();
      return;
    }
    previewRows = 3;
    previewColumns = 4;
    closeDiagramPicker();
    closeWidthPicker();
    openTablePicker();
  }

  function handleTablePickerKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTablePicker();
    }
  }

  function closeDiagramPicker() {
    diagramPickerOpen = false;
  }

  function toggleDiagramPicker() {
    closeTablePicker();
    closeWidthPicker();
    diagramPickerOpen = !diagramPickerOpen;
  }

  function closeWidthPicker() {
    widthPickerOpen = false;
  }

  function toggleWidthPicker() {
    closeTablePicker();
    closeDiagramPicker();
    widthPickerOpen = !widthPickerOpen;
  }

  function handleWidthPickerKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWidthPicker();
    }
  }

  function openLinkEditor() {
    closeDiagramPicker();
    closeWidthPicker();
    openLinkPicker();
  }

  function openSearch() {
    closeTablePicker();
    closeDiagramPicker();
    closeWidthPicker();
    openSearchPanel();
  }

  function closeResponsivePickers() {
    mathPickerOpen = false;
    closeTablePicker();
    closeDiagramPicker();
    closeWidthPicker();
  }

  function toggleMathPicker() {
    const open = !mathPickerOpen;
    closeResponsivePickers();
    mathPickerOpen = open;
  }

  function insertMath(command: EditorCommand) {
    mathPickerOpen = false;
    runCommand(command);
  }

  function insertBlankDiagram() {
    runCommand({ type: 'insertMermaidBlock' });
    closeDiagramPicker();
  }

  function insertDiagram(diagramType: DiagramType) {
    runCommand({ type: 'insertDiagramBlock', diagramType });
    closeDiagramPicker();
  }

  function handleDiagramPickerKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDiagramPicker();
    }
  }
</script>

<svelte:window on:resize={closeResponsivePickers} />

{#key interfaceLocale}
  <div
    class="toolbar"
    aria-label={t.formatToolbar()}
    data-interface-locale={interfaceLocale}
  >
    <div class="toolbar-actions-scroll" use:trackToolbarScroll>
    <div class="toolbar-group toolbar-group-core">
      <button
        title={t.title()}
        aria-label={t.setHeadingOne()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'setHeading', level: 1 })}
      >
        <Heading1 size={17} />
      </button>
      <button
        title={t.bold()}
        aria-label={t.toggleBold()}
        class:active={pendingInlineMarks.strong}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleBold' })}
      >
        <Bold size={17} />
      </button>
      <button
        title={t.italic()}
        aria-label={t.toggleItalic()}
        class:active={pendingInlineMarks.em}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleItalic' })}
      >
        <Italic size={17} />
      </button>
      <button
        title={t.strikethrough()}
        aria-label={t.toggleStrikethrough()}
        class:active={pendingInlineMarks.strikethrough}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleStrikethrough' })}
      >
        <Strikethrough size={17} />
      </button>
      <button
        title={t.underline()}
        aria-label={t.toggleUnderline()}
        class:active={pendingInlineMarks.underline}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleUnderline' })}
      >
        <Underline size={17} />
      </button>
      <button
        title={t.highlight()}
        aria-label={t.toggleHighlight()}
        class:active={pendingInlineMarks.highlight}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleHighlight' })}
      >
        <Highlighter size={17} />
      </button>
      <button
        title={t.superscript()}
        aria-label={t.toggleSuperscript()}
        class:active={pendingInlineMarks.superscript}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleSuperscript' })}
      >
        <Superscript size={17} />
      </button>
      <button
        title={t.subscript()}
        aria-label={t.toggleSubscript()}
        class:active={pendingInlineMarks.subscript}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleSubscript' })}
      >
        <Subscript size={17} />
      </button>
      <button
        title={t.link()}
        aria-label={t.editLink()}
        on:mousedown|preventDefault
        on:click={openLinkEditor}
      >
        <Link size={17} />
      </button>
      <button
        title={formatPainterActive ? t.formatPainterCancelled() : t.formatPainter()}
        aria-label={formatPainterActive ? t.formatPainterCancelled() : t.formatPainter()}
        aria-pressed={formatPainterActive}
        class:active={formatPainterActive}
        on:mousedown|preventDefault
        on:click={toggleFormatPainter}
      >
        <Paintbrush size={17} />
      </button>
    </div>

    <div class="toolbar-group toolbar-group-medium">
      <button
        title={t.inlineComment()}
        aria-label={t.insertInlineComment()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'insertCommentInline' })}
      >
        <MessageSquare size={17} />
      </button>
      <button
        title={t.quote()}
        aria-label={t.toggleQuote()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleBlockquote' })}
      >
        <Quote size={17} />
      </button>
      <button
        title={t.callout()}
        aria-label={t.insertCallout()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'insertCallout' })}
      >
        <Info size={17} />
      </button>
      <button title={t.details()} aria-label={t.insertDetails()} on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'insertDetails' })}>
        <PanelTopClose size={17} />
      </button>
      <button
        title={t.unorderedList()}
        aria-label={t.toggleList()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleBulletList' })}
      >
        <List size={17} />
      </button>
      <button
        title={t.taskList()}
        aria-label={t.toggleTaskList()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'toggleTaskList' })}
      >
        <CheckSquare size={17} />
      </button>
    </div>

    <div class="toolbar-group toolbar-group-low">
      <div class="table-picker-anchor" use:clickOutside={closeTablePicker}>
        <button
          title={t.table()}
          aria-haspopup="dialog"
          aria-expanded={tablePickerOpen}
          aria-label={t.insertTable()}
          class:active={tablePickerOpen}
          on:click|stopPropagation={toggleTablePicker}
        >
          <Table2 size={17} />
        </button>
        {#if tablePickerOpen}
          <div
            class="table-picker-popover"
            role="dialog"
            aria-label={t.chooseTableSize()}
            tabindex="-1"
            on:keydown={handleTablePickerKeydown}
          >
            <div class="table-picker-header">
              <span>{t.table()}</span>
              <strong>{previewRows} × {previewColumns}</strong>
            </div>
            <div class="table-picker-grid" aria-label={t.tableRowsColumns()}>
              {#each tableRows as row}
                {#each tableColumns as column}
                  <button
                    type="button"
                    class="table-picker-cell"
                    class:active={row <= previewRows && column <= previewColumns}
                    aria-label={t.insertTableSize({ rows: row, columns: column })}
                    on:mouseenter={() => {
                      previewRows = row;
                      previewColumns = column;
                    }}
                    on:focus={() => {
                      previewRows = row;
                      previewColumns = column;
                    }}
                    on:click={() => insertTableWithSize(row, column)}
                  ></button>
                {/each}
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <button
        title={t.codeBlock()}
        aria-label={t.insertCodeBlock()}
        on:click={() => runCommand({ type: 'insertCodeBlock' })}
      >
        <Code2 size={17} />
      </button>
      <div class="diagram-picker-anchor" use:clickOutside={() => mathPickerOpen = false}>
        <button title={t.mathFormula()} aria-label={t.insertMathFormula()} aria-haspopup="menu"
          aria-expanded={mathPickerOpen} class:active={mathPickerOpen} on:mousedown|preventDefault
          on:click|stopPropagation={toggleMathPicker}>
          <Sigma size={17} />
        </button>
        {#if mathPickerOpen}
          <div class="diagram-picker-popover" role="menu" aria-label={t.insertMathFormula()} tabindex="-1"
            on:keydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); mathPickerOpen = false; } }}>
            <button type="button" role="menuitem" disabled={mathInlineInsertionDisabled || mode === 'source'}
              on:mousedown|preventDefault on:click={() => insertMath({ type: 'insertMathInline' })}>
              <span>{t.mathInline()}</span><small>$…$</small>
            </button>
            <button type="button" role="menuitem" on:mousedown|preventDefault
              on:click={() => insertMath({ type: 'insertMathBlock', tex: 'E = mc^2' })}>
              <span>{t.mathBlock()}</span><small>$$…$$</small>
            </button>
          </div>
        {/if}
      </div>
      <div class="diagram-picker-anchor" use:clickOutside={closeDiagramPicker}>
        <button
          title={t.diagram()}
          aria-haspopup="menu"
          aria-expanded={diagramPickerOpen}
          aria-label={t.insertDiagram()}
          class:active={diagramPickerOpen}
          on:click|stopPropagation={toggleDiagramPicker}
        >
          <Braces size={17} />
        </button>
        {#if diagramPickerOpen}
          <div
            class="diagram-picker-popover"
            role="menu"
            aria-label={t.insertDiagram()}
            tabindex="-1"
            on:keydown={handleDiagramPickerKeydown}
          >
            <div class="diagram-picker-header">{t.diagram()}</div>
            <button type="button" role="menuitem" on:click={insertBlankDiagram}>
              <span>{t.blankDiagram()}</span>
              <small>mermaid</small>
            </button>
            <div class="diagram-picker-header">{t.template()}</div>
            {#each DIAGRAM_TEMPLATES as template}
              <button type="button" role="menuitem" on:click={() => insertDiagram(template.type)}>
                <span>{getDiagramTypeLabel(template.type)}</span>
                <small>{template.type}</small>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button
        title={t.insertFootnote()}
        aria-label={t.insertFootnote()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'insertFootnote' })}
      >
        <Superscript size={17} />
      </button>
      <button
        title={t.insertToc()}
        aria-label={t.insertToc()}
        on:mousedown|preventDefault
        on:click={() => runCommand({ type: 'insertToc' })}
      >
        <TableOfContents size={17} />
      </button>
    </div>
    <span class="divider toolbar-actions-divider"></span>
    </div>
    <span class="toolbar-spacer"></span>
    <div class="toolbar-utilities">
      <button
        class="icon-button"
        title={t.searchReplace()}
        aria-label={t.searchReplace()}
        on:click={openSearch}
      >
        <Search size={18} />
      </button>
      <label
        class="range-control width-control width-control-expanded"
        title={mode === 'split' ? t.splitAdaptiveWidth() : t.contentWidth()}
      >
        <AlignHorizontalSpaceAround size={16} aria-hidden="true" />
        <span>{contentWidthPercent}%</span>
        <input
          type="range"
          min="40"
          max="90"
          step="1"
          value={contentWidthPercent}
          disabled={mode === 'split'}
          use:typographyRange={'width'}
          on:input={updateContentWidth}
        />
      </label>
      <div class="width-control-compact-anchor" use:clickOutside={closeWidthPicker}>
        <button
          class="width-control-compact"
          class:active={widthPickerOpen}
          type="button"
          title={mode === 'split' ? t.splitAdaptiveWidth() : t.contentWidth()}
          aria-label={mode === 'split' ? t.splitAdaptiveWidth() : t.contentWidth()}
          disabled={mode === 'split'}
          aria-haspopup="dialog"
          aria-expanded={widthPickerOpen}
          on:click|stopPropagation={toggleWidthPicker}
          on:keydown={handleWidthPickerKeydown}
        >
          <AlignHorizontalSpaceAround size={15} aria-hidden="true" />
          <span>{contentWidthPercent}%</span>
        </button>
        {#if widthPickerOpen}
          <div class="width-control-popover" role="dialog" aria-label={t.contentWidth()}>
            <strong>{t.contentWidth()}</strong>
            <span>{contentWidthPercent}%</span>
            <input
              type="range"
              min="40"
              max="90"
              step="1"
              value={contentWidthPercent}
              disabled={mode === 'split'}
              aria-label={t.contentWidth()}
              use:typographyRange={'width'}
              on:input={updateContentWidth}
              on:keydown={handleWidthPickerKeydown}
            />
          </div>
        {/if}
      </div>
      <!--
        目录与文档属性共用一个右侧抽屉，所以入口也放在同一个分段控件里，
        视觉上明确「它们是同一个抽屉的两个标签页」。AI 助手是独立抽屉，放在最右。
      -->
      <div class="drawer-switch" class:one-mode={!docxMode} role="group" aria-label={t.documentOutline()}>
        <button
          class="drawer-switch-button"
          class:active={outlineVisible && !docxInspectorVisible}
          title={outlineVisible && !docxInspectorVisible ? t.hideOutline() : t.showOutline()}
          aria-label={outlineVisible && !docxInspectorVisible ? t.hideOutline() : t.showOutline()}
          aria-pressed={outlineVisible && !docxInspectorVisible}
          on:click={toggleOutlineVisible}
        >
          <ListTree size={17} />
        </button>
        {#if docxMode}
          <button
            class="drawer-switch-button"
            class:active={docxInspectorVisible}
            title={docxInspectorVisible ? t.docxHideInspector() : t.docxShowInspector()}
            aria-label={docxInspectorVisible ? t.docxHideInspector() : t.docxShowInspector()}
            aria-pressed={docxInspectorVisible}
            on:click={toggleDocxInspector}
          >
            <SlidersHorizontal size={17} />
          </button>
        {/if}
      </div>
      <button
        class="icon-button"
        class:active={aiPanelVisible}
        title={aiPanelVisible ? t.aiHidePanel() : t.aiShowPanel()}
        aria-label={aiPanelVisible ? t.aiHidePanel() : t.aiShowPanel()}
        aria-pressed={aiPanelVisible}
        on:click={toggleAiPanel}
      >
        <Sparkles size={18} />
      </button>
      <button
        class="toolbar-collapse-button"
        type="button"
        title={`${t.hideToolbar()} (${toolbarShortcut})`}
        aria-label={t.hideToolbar()}
        on:click={toggleToolbar}
      >
        <ChevronUp size={16} />
      </button>
    </div>
  </div>
{/key}
