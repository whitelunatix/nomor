<script lang="ts">
  import { Code2, FileText, Plus, SlidersHorizontal, X } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { EditorCore } from '../../../lib/editor-core';
  import type { DocxEdit } from '../../../lib/docxmd/directivePatch';
  import type {
    DocxDocumentEntry,
    DocxEditorContext,
    DocxEffectiveSummary,
  } from '../../../lib/docxmd/inspector';
  import {
    DOCX_BLOCK_TEMPLATES as BLOCK_TEMPLATES,
    DOCX_META_TEMPLATES as META_TEMPLATES,
  } from '../../../lib/docxmd/templates';
  import {
    isPythonValidatorAvailable,
    validateDocxMarkdownWithPython,
  } from '../../../lib/docxmd/pythonValidator';
  import { validateDocxMarkdown, type DocxValidationSummary } from '../../../lib/docxmd/validate';
  import { t } from '../../i18n';
  import DocxDirectiveCard from './DocxDirectiveCard.svelte';

  export let core: EditorCore;
  export let readonly = false;
  export let onClose: () => void = () => undefined;
  /** 嵌进共用抽屉时，标题与关闭按钮由抽屉头部负责。 */
  export let embedded = false;
  /** 当前 `.docx.md` 的绝对路径；交给 Python 校验进程定位同目录资源。 */
  export let documentPath: string | null = null;

  const STYLE_LABELS: Record<string, string> = {
    'font-family': '字体',
    'font-size': '字号',
    'font-style': '字形',
    'font-weight': '字重',
    'line-height': '行距',
    'text-align': '对齐',
    'text-indent': '缩进',
    'margin-top': '段前',
    'margin-bottom': '段后',
    'margin-left': '左缩进',
    'margin-right': '右缩进',
    'padding-left': '左留白',
    'list-style-type': '列表标记',
  };

  /** 与编辑器核心的大文档阈值保持一致，只用来决定校验延后多久。 */
  const LARGE_DOCUMENT_LENGTH = 100_000;

  let context: DocxEditorContext | null = null;
  let tab: 'block' | 'document' = 'block';
  let openEntryId: string | null = null;
  let addingTemplate = false;
  let stale = false;
  let lastTargetId: string | null = null;
  let lastMetaTargetId: string | null = null;
  let boundCore: EditorCore | null = null;
  let unsubscribe: (() => void) | null = null;
  let diagnostics: DocxValidationSummary | null = null;
  let diagnosticsRevision = -1;
  let scheduledRevision = -1;
  let validationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Python 侧车是最终结果；序号用于丢弃过期的异步响应。 */
  let pythonValidationSeq = 0;
  const pythonValidatorAvailable = isPythonValidatorAvailable();
  /** 最近一次同步后的 Markdown 长度，用来判定大文档（不触发序列化）。 */
  let markdownLength = 0;

  function clearValidationTimer(): void {
    if (!validationTimer) return;
    clearTimeout(validationTimer);
    validationTimer = null;
  }

  /**
   * 全文校验（论文约 30 ms）若在每次按键后同步执行，会逼着编辑器立刻序列化整篇
   * Markdown（约 130 ms）。这里延后到内容稳定后再校验，并且必须排在 Markdown
   * 同步之后：常规文档 120 ms 同步、350 ms 校验；大文档 1 s 同步、1.2 s 校验。
   * 这样 `getMarkdown()` 拿到的已是同步好的字符串，不会再触发额外序列化。
   */
  function scheduleValidation(revision: number): void {
    clearValidationTimer();
    const target = core;
    const largeDocument = markdownLength > LARGE_DOCUMENT_LENGTH;
    validationTimer = setTimeout(() => {
      validationTimer = null;
      if (!target || target !== core) return;
      const markdown = target.getMarkdown();
      // 先给出 TypeScript 的即时结果，桌面端再用 Python 校验结果覆盖；
      // 侧车未就绪或失败时保留这份结果。
      diagnostics = validateDocxMarkdown(markdown);
      diagnosticsRevision = revision;
      if (!pythonValidatorAvailable) return;
      const seq = ++pythonValidationSeq;
      void validateDocxMarkdownWithPython(markdown, documentPath).then((summary) => {
        if (!summary || seq !== pythonValidationSeq || target !== core) return;
        diagnostics = summary;
        diagnosticsRevision = revision;
      });
    }, largeDocument ? 1200 : 350);
  }

  $: if (core !== boundCore) {
    clearValidationTimer();
    pythonValidationSeq += 1;
    unsubscribe?.();
    boundCore = core;
    context = core ? core.getDocxContext() : null;
    markdownLength = core ? core.getSnapshot().markdown.length : 0;
    diagnostics = null;
    diagnosticsRevision = -1;
    scheduledRevision = -1;
    unsubscribe = core
      ? core.subscribe((event) => {
          markdownLength = event.markdown.length;
          context = core.getDocxContext();
        })
      : null;
  }

  // 只在“文档”页按内容版本校验一次；光标移动和面板切块不会重复扫描整篇文档。
  $: if (
    tab === 'document' && core && context &&
    context.revision !== diagnosticsRevision &&
    context.revision !== scheduledRevision
  ) {
    scheduledRevision = context.revision;
    scheduleValidation(context.revision);
  }

  $: if (context) {
    // 切换块后不要保留“添加指令”的展开状态。
    if (context.targetId !== lastTargetId) {
      lastTargetId = context.targetId;
      addingTemplate = false;
      stale = false;
    }
  }

  $: if (context?.kind === 'meta') {
    // 点击分节/页面/目录标记时直接打开文档面板。
    if (context.targetId !== lastMetaTargetId) {
      lastMetaTargetId = context.targetId;
      tab = 'document';
      openEntryId = context.targetId;
    }
  } else if (context) {
    lastMetaTargetId = null;
  }

  onDestroy(() => {
    clearValidationTimer();
    pythonValidationSeq += 1;
    unsubscribe?.();
  });

  function applyEdits(targetId: string, edits: DocxEdit[]): boolean {
    if (!context || readonly) return false;
    const ok = core.execute({
      type: 'applyDocxEdits',
      revision: context.revision,
      targetId,
      edits,
    });
    stale = !ok;
    context = core.getDocxContext();
    return ok;
  }

  function addDirective(raw: string): void {
    if (!context?.targetId) return;
    const ok = applyEdits(context.targetId, [
      { type: 'addDirective', lineIndex: context.directives.length, raw },
    ]);
    if (ok) addingTemplate = false;
  }

  function addDirectiveTo(entry: DocxDocumentEntry, raw: string): void {
    const ok = applyEdits(entry.targetId, [
      { type: 'addDirective', lineIndex: entry.directives.length, raw },
    ]);
    if (ok) openEntryId = entry.targetId;
  }

  function toggleDirectiveSource(): void {
    if (!context) return;
    core.execute({
      type: 'setDocxDirectivesVisible',
      visible: !context.directivesVisible,
    });
    context = core.getDocxContext();
  }

  function styleLabel(name: string): string {
    return STYLE_LABELS[name] ?? name;
  }

  function describeStyle(style: Record<string, string>): string {
    return Object.entries(style)
      .map(([name, value]) => `${styleLabel(name)} ${value}`)
      .join('，');
  }

  function severityLabel(severity: 'error' | 'warning' | 'info'): string {
    return severity === 'error'
      ? t.docxSeverityError()
      : severity === 'warning'
        ? t.docxSeverityWarning()
        : t.docxSeverityInfo();
  }

  function jumpToDiagnostic(sourceLine: number | undefined): void {
    if (!sourceLine) return;
    core.revealMarkdownLine(sourceLine);
  }

  function effectiveFacts(effective: DocxEffectiveSummary): Array<{ label: string; value: string }> {
    const facts: Array<{ label: string; value: string }> = [];
    if (effective.headingLevel) facts.push({ label: '标题级别', value: `h${effective.headingLevel}` });
    if (effective.listFormat) facts.push({ label: '列表标记', value: effective.listFormat });
    if (effective.listStart != null) facts.push({ label: '列表起始', value: String(effective.listStart) });
    if (effective.listLevel != null) facts.push({ label: '列表级别', value: String(effective.listLevel) });
    if (effective.listMarker) facts.push({ label: '编号文本', value: effective.listMarker });
    if (effective.image) {
      const image = effective.image;
      if (image.width) facts.push({ label: '图片宽', value: image.width });
      if (image.height) facts.push({ label: '图片高', value: image.height });
      if (image.align) facts.push({ label: '图片对齐', value: image.align });
      if (image.wrap) facts.push({ label: '环绕', value: image.wrap });
    }
    if (effective.caption) {
      facts.push({ label: '题注类型', value: effective.caption.type ?? 'figure' });
      if (effective.caption.id) facts.push({ label: '题注标识', value: effective.caption.id });
    }
    if (effective.formula) {
      if (effective.formula.number) facts.push({ label: '公式编号', value: effective.formula.number });
      if (effective.formula.id) facts.push({ label: '公式标识', value: effective.formula.id });
    }
    if (effective.reference?.id) {
      facts.push({ label: '文献标识', value: effective.reference.id });
    }
    if (effective.break) {
      facts.push({ label: '分隔类型', value: effective.break.type ?? 'page' });
      facts.push({ label: '分隔位置', value: effective.break.position ?? 'before' });
    }
    if (effective.table) {
      const table = effective.table;
      facts.push({
        label: '表格边框',
        value: [
          table.borderVisible.join(' '),
          table.borderWidth,
          table.borderStyle,
          table.borderColor,
        ]
          .filter(Boolean)
          .join(' '),
      });
      if (table.colWidths?.length) {
        facts.push({ label: '列宽', value: table.colWidths.join(' | ') });
      }
      if (table.align) facts.push({ label: '表格对齐', value: table.align });
      if (table.rowVAlign) facts.push({ label: '单元格垂直对齐', value: table.rowVAlign });
      if (table.continuation) {
        const continuation = table.continuation;
        const rows = continuation.startRows.length
          ? `第 ${continuation.startRows.join('、')} 行`
          : '未指定拆分行';
        facts.push({
          label: '续表',
          value: [rows, continuation.title, continuation.captionId]
            .filter(Boolean)
            .join(' · '),
        });
      }
      if (table.paragraphs.length) {
        facts.push({
          label: '单元格段落样式',
          value: table.paragraphs
            .map((paragraph) => `${paragraph.selector} ${describeStyle(paragraph.style)}`.trim())
            .join('；'),
        });
      }
    }
    return facts;
  }
</script>

<aside class="docx-inspector" class:embedded aria-label={t.docxInspector()}>
  <header class="docx-inspector-header">
    {#if !embedded}<strong>{t.docxInspector()}</strong>{/if}
    <div class="docx-inspector-actions">
      <button
        type="button"
        class="docx-icon-button"
        class:active={context?.directivesVisible}
        title={context?.directivesVisible ? t.docxHideDirectives() : t.docxShowDirectives()}
        aria-label={context?.directivesVisible ? t.docxHideDirectives() : t.docxShowDirectives()}
        aria-pressed={context?.directivesVisible ?? false}
        disabled={readonly}
        on:click={toggleDirectiveSource}
      >
        <Code2 size={15} />
      </button>
      {#if !embedded}
        <button
          type="button"
          class="docx-icon-button"
          title={t.close()}
          aria-label={t.docxInspectorClose()}
          on:click={onClose}
        >
          <X size={15} />
        </button>
      {/if}
    </div>
  </header>

  {#if context}
    <div class="docx-inspector-target">
      <span class="docx-kind-chip">{context.kind === 'tableCell' ? '单元格' : context.kind === 'meta' ? '结构' : '内容'}</span>
      <span class="docx-target-label" title={context.text}>{context.label}</span>
    </div>
    {#if context.table}
      <div class="docx-table-position">
        {t.docxTablePosition({
          rows: context.table.rows,
          columns: context.table.columns,
          row: context.table.row + 1,
          column: context.table.column + 1,
        })}
        {#if context.table.merged}<span class="docx-merged-chip">合并</span>{/if}
      </div>
    {/if}

    <nav class="docx-inspector-tabs" aria-label={t.docxInspector()}>
      <button
        type="button"
        class:active={tab === 'block'}
        on:click={() => (tab = 'block')}
      >
        <SlidersHorizontal size={14} />
        {t.docxTabBlock()}
      </button>
      <button
        type="button"
        class:active={tab === 'document'}
        on:click={() => (tab = 'document')}
      >
        <FileText size={14} />
        {t.docxTabDocument()}
      </button>
    </nav>

    <div class="docx-inspector-body">
      {#if stale}
        <p class="docx-stale" role="status">{t.docxStaleRevision()}</p>
      {/if}

      {#if tab === 'block'}
        {#if context.directives.length === 0}
          <p class="docx-empty-hint">{t.docxNoDirectives()}</p>
        {:else}
          <div class="docx-directive-list">
            {#each context.directives as directive (directive.lineIndex)}
              <DocxDirectiveCard
                {directive}
                targetId={context.targetId ?? ''}
                {readonly}
                {applyEdits}
              />
            {/each}
          </div>
        {/if}

        {#if !readonly && context.targetId}
          <div class="docx-template-adder">
            <button
              type="button"
              class="docx-add-directive"
              on:click={() => (addingTemplate = !addingTemplate)}
            >
              <Plus size={13} />
              {t.docxAddDirective()}
            </button>
            {#if addingTemplate}
              <div class="docx-template-list">
                {#each context.kind === 'meta' ? META_TEMPLATES : BLOCK_TEMPLATES as template}
                  <button type="button" title={template.raw} on:click={() => addDirective(template.raw)}>
                    {template.label}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if context.effective}
          <details class="docx-effective" open>
            <summary>{t.docxEffectiveStyle()}</summary>
            <dl class="docx-fact-list">
              {#each effectiveFacts(context.effective) as fact}
                <div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
              {/each}
              {#each Object.entries(context.effective.style) as [name, value]}
                <div class:docx-style-variable={name.startsWith('--')}>
                  <dt>{styleLabel(name)}</dt>
                  <dd>{value}</dd>
                </div>
              {/each}
            </dl>
          </details>
        {/if}
      {:else}
        <section class="docx-document-panel">
          {#if diagnostics}
            <details class="docx-diagnostics" open={diagnostics.diagnostics.length > 0}>
              <summary>
                <span>{t.docxDiagnostics()}</span>
                <span
                  class="docx-diagnostics-counts"
                  class:has-errors={diagnostics.errorCount > 0}
                >
                  {t.docxDiagnosticsSummary({
                    errors: diagnostics.errorCount,
                    warnings: diagnostics.warningCount,
                  })}
                </span>
              </summary>
              <p class="docx-diagnostics-meta">
                {t.docxCheckedDirectives({ count: diagnostics.directiveCount })}
              </p>
              {#if diagnostics.diagnostics.length === 0}
                <p class="docx-empty-hint">{t.docxNoDiagnostics()}</p>
              {:else}
                <ul class="docx-diagnostic-list">
                  {#each diagnostics.diagnostics.slice(0, 80) as diagnostic, index (index)}
                    <li class="docx-diagnostic" class:is-error={diagnostic.severity === 'error'}>
                      <span class="docx-diagnostic-severity">
                        {severityLabel(diagnostic.severity)}
                      </span>
                      {#if diagnostic.sourceLine}
                        <button
                          type="button"
                          class="docx-diagnostic-message"
                          title={t.docxDiagnosticJump({ line: diagnostic.sourceLine })}
                          on:click={() => jumpToDiagnostic(diagnostic.sourceLine)}
                        >
                          {diagnostic.message}
                          <span class="docx-diagnostic-line">
                            {t.docxDiagnosticLine({ line: diagnostic.sourceLine })}
                          </span>
                        </button>
                      {:else}
                        <span class="docx-diagnostic-message">{diagnostic.message}</span>
                      {/if}
                    </li>
                  {/each}
                </ul>
                {#if diagnostics.diagnostics.length > 80}
                  <p class="docx-diagnostics-meta">
                    {t.docxDiagnosticsTruncated({
                      count: 80,
                      total: diagnostics.diagnostics.length,
                    })}
                  </p>
                {/if}
              {/if}
            </details>
          {/if}

          {#if context.document.length === 0}
            <p class="docx-empty-hint">{t.docxNoDocumentDirectives()}</p>
          {:else}
            {#each context.document as entry (entry.targetId)}
              <div class="docx-document-entry">
                <button
                  type="button"
                  class="docx-document-row"
                  class:open={openEntryId === entry.targetId}
                  on:click={() => (openEntryId = openEntryId === entry.targetId ? null : entry.targetId)}
                >
                  <span class="docx-meta-badge">{entry.badge}</span>
                  {#if entry.sectionIndex}<span class="docx-section-index">{t.docxSectionLabel({ index: entry.sectionIndex })}</span>{/if}
                  <span class="docx-document-summary" title={entry.summary}>
                    {entry.summary || `${entry.lineCount} 条指令`}
                  </span>
                </button>
                {#if openEntryId === entry.targetId}
                  <div class="docx-document-detail">
                    {#each entry.directives as directive (directive.lineIndex)}
                      <DocxDirectiveCard
                        {directive}
                        targetId={entry.targetId}
                        {readonly}
                        {applyEdits}
                      />
                    {/each}
                    {#if entry.directives.length === 0}
                      <p class="docx-empty-hint">{t.docxNoDirectives()}</p>
                    {/if}
                    {#if !readonly}
                      <div class="docx-template-list">
                        {#each META_TEMPLATES as template}
                          <button
                            type="button"
                            title={template.raw}
                            on:click={() => addDirectiveTo(entry, template.raw)}
                          >
                            {template.label}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}

          {#if Object.keys(context.globals.font).length > 0 || Object.keys(context.globals.paragraph).length > 0}
            <details class="docx-effective">
              <summary>{t.docxDocumentDefaults()}</summary>
              {#if Object.keys(context.globals.font).length > 0}
                <h4>字体</h4>
                <dl class="docx-fact-list">
                  {#each Object.entries(context.globals.font) as [name, value]}
                    <div><dt>{styleLabel(name)}</dt><dd>{value}</dd></div>
                  {/each}
                </dl>
              {/if}
              {#if Object.keys(context.globals.paragraph).length > 0}
                <h4>段落</h4>
                <dl class="docx-fact-list">
                  {#each Object.entries(context.globals.paragraph) as [name, value]}
                    <div><dt>{styleLabel(name)}</dt><dd>{value}</dd></div>
                  {/each}
                </dl>
              {/if}
            </details>
          {/if}

          {#if context.globals.variables.length > 0}
            <details class="docx-effective">
              <summary>{t.docxVariables()}</summary>
              <div class="docx-variable-list">
                {#each context.globals.variables as name}
                  <code>{name}</code>
                {/each}
              </div>
            </details>
          {/if}
        </section>
      {/if}
    </div>
  {:else}
    <p class="docx-empty-hint">{t.docxNoDirectives()}</p>
  {/if}
</aside>
