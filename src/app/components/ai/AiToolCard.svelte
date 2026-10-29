<script lang="ts">
  import type { AssistantToolInvocation } from '../../../lib/assistant/types';
  import { t } from '../../i18n';

  export let tool: AssistantToolInvocation;

  /** 超过这个长度默认折叠，避免一条工具结果占满整个面板。 */
  const PREVIEW_CHARS = 2000;

  let expanded = false;

  /** 工具名 → 用户看得懂的动作。未知工具（例如 MCP）直接显示原名。 */
  function toolLabel(name: string): string {
    const labels: Record<string, string> = {
      doc_outline: t.aiToolDocOutline(),
      doc_read: t.aiToolDocRead(),
      doc_search: t.aiToolDocSearch(),
      doc_selection: t.aiToolDocSelection(),
      doc_diagnostics: t.aiToolDocDiagnostics(),
      doc_apply_edit: t.aiToolDocApplyEdit(),
      file_list: t.aiToolFileList(),
      file_read: t.aiToolFileRead(),
      file_write: t.aiToolFileWrite(),
      skill_list: t.aiToolSkillList(),
      skill_load: t.aiToolSkillLoad(),
      skill_file_read: t.aiToolSkillFileRead(),
      shell_exec: t.aiToolShellExec(),
    };
    return labels[name] ?? name;
  }

  function statusLabel(status: AssistantToolInvocation['status']): string {
    switch (status) {
      case 'pending-approval':
        return t.aiToolPendingApproval();
      case 'running':
        return t.aiToolRunning();
      case 'success':
        return t.aiToolSuccess();
      case 'denied':
        return t.aiToolDenied();
      default:
        return t.aiToolError();
    }
  }

  function formatInput(input: unknown): string {
    if (input === undefined) return '';
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }

  /** 摘要行只展示最关键的一个参数，完整参数仍在展开区。 */
  function summarizeInput(input: unknown): string {
    if (!input || typeof input !== 'object') {
      return '';
    }
    const record = input as Record<string, unknown>;
    const command = record.command;
    if (typeof command === 'string' && command.trim()) {
      return command.trim().replace(/\s+/g, ' ').slice(0, 80);
    }
    const path = record.path ?? record.relativePath;
    if (typeof path === 'string' && path.trim()) {
      return path.trim().slice(0, 80);
    }
    const heading = record.heading;
    if (typeof heading === 'string' && heading.trim()) {
      return `# ${heading.trim().slice(0, 60)}`;
    }
    if (typeof record.fromLine === 'number' && typeof record.toLine === 'number') {
      return `L${record.fromLine}–L${record.toLine}`;
    }
    const id = record.id;
    if (typeof id === 'string' && id.trim()) {
      return id.trim().slice(0, 60);
    }
    const query = record.query;
    if (typeof query === 'string' && query.trim()) {
      return query.trim().slice(0, 60);
    }
    return '';
  }

  $: output = tool.output ?? '';
  $: truncated = output.length > PREVIEW_CHARS;
  $: visibleOutput = truncated && !expanded ? output.slice(0, PREVIEW_CHARS) : output;
  $: summary = summarizeInput(tool.input);
  $: elapsed =
    tool.startedAt && tool.finishedAt
      ? Math.max(0, (tool.finishedAt - tool.startedAt) / 1000)
      : null;
  $: elapsedLabel =
    elapsed === null
      ? ''
      : elapsed < 0.1
        ? '<0.1s'
        : elapsed < 10
          ? `${elapsed.toFixed(1)}s`
          : `${Math.round(elapsed)}s`;
</script>

<details
  class="ai-tool-card"
  class:error={tool.status === 'error'}
  class:success={tool.status === 'success'}
  class:denied={tool.status === 'denied'}
  class:pending={tool.status === 'pending-approval'}
>
  <summary>
    <span class="ai-tool-heading">
      <span class="ai-tool-name">{toolLabel(tool.name)}</span>
      {#if summary}
        <span class="ai-tool-summary" title={summary}>{summary}</span>
      {/if}
    </span>
    <span class="ai-tool-status">
      {#if elapsedLabel}
        <span class="ai-tool-elapsed">{elapsedLabel}</span>
      {/if}
      {statusLabel(tool.status)}
    </span>
  </summary>
  {#if tool.input !== undefined}
    <pre class="ai-tool-input">{formatInput(tool.input)}</pre>
  {/if}
  {#if output}
    <pre class="ai-tool-output">{visibleOutput}</pre>
    {#if truncated}
      <div class="ai-tool-truncated">
        <span>{t.aiToolTruncated({ total: String(output.length) })}</span>
        <button type="button" class="ai-link-button" on:click={() => (expanded = !expanded)}>
          {expanded ? t.aiToolCollapse() : t.aiToolExpand()}
        </button>
      </div>
    {/if}
  {/if}
  {#if tool.error}
    <p class="ai-tool-message">{tool.error}</p>
  {/if}
</details>
