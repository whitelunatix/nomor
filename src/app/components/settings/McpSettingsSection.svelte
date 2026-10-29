<script lang="ts">
  import { Loader2 } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import {
    checkMcpHealth,
    connectMcpServer,
    disconnectMcpServer,
    importMcpConfig,
    readMcpConfig,
    scanMcpImports,
    setMcpTrusted,
    writeMcpConfig,
  } from '../../../lib/assistant/mcp';
  import type {
    McpConfigView,
    McpImportSource,
    McpServerStatus,
  } from '../../../lib/assistant/types';
  import { isTauriRuntime } from '../../../lib/desktop/tauriStorage';
  import { t } from '../../i18n';

  /**
   * 「MCP 服务器」设置分区。
   *
   * 配置文件本身是通用的 `mcpServers` JSON，这里既提供服务器状态卡片，
   * 也允许直接编辑原文；保存先校验再落盘，坏 JSON 不会覆盖原文件。
   */

  let view: McpConfigView | null = null;
  let draft = '';
  let loaded = false;
  let errorMessage = '';
  let okMessage = '';
  let busy = '';
  let sources: McpImportSource[] | null = null;
  let scanning = false;
  let importing = '';
  let replaceExisting = false;
  const desktop = isTauriRuntime();

  onMount(() => {
    if (!desktop) {
      loaded = true;
      return;
    }
    void (async () => {
      try {
        apply(await readMcpConfig());
      } catch (error) {
        errorMessage = messageOf(error);
      }
      loaded = true;
    })();
  });

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function apply(next: McpConfigView | null): void {
    if (!next) {
      return;
    }
    view = next;
    draft = next.text;
  }

  async function refresh(): Promise<void> {
    apply(await readMcpConfig());
  }

  async function save(): Promise<void> {
    errorMessage = '';
    okMessage = '';
    busy = 'save';
    try {
      apply(await writeMcpConfig(draft));
      okMessage = t.aiMcpSaved();
    } catch (error) {
      errorMessage = messageOf(error);
    } finally {
      busy = '';
    }
  }

  async function connect(server: McpServerStatus): Promise<void> {
    errorMessage = '';
    okMessage = '';
    busy = server.id;
    try {
      await connectMcpServer(server.id);
      await refresh();
    } catch (error) {
      errorMessage = t.aiMcpConnectFailed({ error: messageOf(error) });
      await refresh().catch(() => undefined);
    } finally {
      busy = '';
    }
  }

  async function disconnect(server: McpServerStatus): Promise<void> {
    errorMessage = '';
    okMessage = '';
    busy = server.id;
    try {
      await disconnectMcpServer(server.id);
      await refresh();
    } catch (error) {
      errorMessage = messageOf(error);
    } finally {
      busy = '';
    }
  }

  async function health(server: McpServerStatus): Promise<void> {
    errorMessage = '';
    okMessage = '';
    busy = server.id;
    try {
      const [result] = await checkMcpHealth(server.id, true);
      if (result?.connected) {
        okMessage = t.aiMcpHealthOk({ count: String(result.toolCount) });
      } else {
        errorMessage = t.aiMcpHealthFailed({ error: result?.error ?? '' });
      }
      await refresh();
    } catch (error) {
      errorMessage = t.aiMcpHealthFailed({ error: messageOf(error) });
      await refresh().catch(() => undefined);
    } finally {
      busy = '';
    }
  }

  async function scan(): Promise<void> {
    errorMessage = '';
    okMessage = '';
    scanning = true;
    try {
      sources = await scanMcpImports();
      if (!sources.some((source) => source.exists)) {
        okMessage = t.aiMcpImportNone();
      }
    } catch (error) {
      errorMessage = messageOf(error);
    } finally {
      scanning = false;
    }
  }

  async function runImport(source: McpImportSource): Promise<void> {
    errorMessage = '';
    okMessage = '';
    importing = source.kind;
    try {
      const result = await importMcpConfig(source.kind, { replaceExisting });
      apply(result.config);
      sources = await scanMcpImports().catch(() => sources);
      okMessage = t.aiMcpImportDone({
        imported: String(result.imported.length),
        skipped: String(result.skipped.length),
        conflicts: String(result.conflicts.length),
      });
    } catch (error) {
      errorMessage = t.aiMcpImportFailed({ error: messageOf(error) });
    } finally {
      importing = '';
    }
  }

  async function toggleTrust(server: McpServerStatus, trusted: boolean): Promise<void> {
    errorMessage = '';
    okMessage = '';
    busy = server.id;
    try {
      apply(await setMcpTrusted(server.id, trusted));
    } catch (error) {
      errorMessage = messageOf(error);
    } finally {
      busy = '';
    }
  }
</script>

{#if !loaded}
  <div class="settings-group">
    <p class="mcp-hint">{t.aiLoading()}</p>
  </div>
{:else}
  <div class="settings-group">
    <h2>{t.aiMcpSectionTitle()}</h2>
    <p class="mcp-hint">{t.aiMcpSectionDescription()}</p>
    {#if !desktop}
      <p class="mcp-warning">{t.aiSettingsDesktopOnly()}</p>
    {:else if view}
      <p class="mcp-hint mcp-path">{t.aiMcpConfigPath({ path: view.path })}</p>
    {/if}
    {#if errorMessage}
      <p class="mcp-error" role="alert">{errorMessage}</p>
    {/if}
    {#if okMessage}
      <p class="mcp-ok">{okMessage}</p>
    {/if}
  </div>

  {#if desktop && view}
    {#if view.parseError}
      <div class="settings-group">
        <p class="mcp-error" role="alert">
          {t.aiMcpParseError({ error: view.parseError })}
        </p>
      </div>
    {/if}

    {#if view.servers.length === 0}
      <div class="settings-group">
        <p class="mcp-hint">{t.aiMcpNoServers()}</p>
      </div>
    {/if}

    {#each view.servers as server (server.id)}
      <div class="settings-group mcp-card">
        <div class="mcp-card-head">
          <strong>{server.id}</strong>
          <span class="mcp-badge">{server.transport}</span>
          <span class="mcp-badge" class:on={server.connected}>
            {server.connected ? t.aiMcpConnected() : t.aiMcpDisconnected()}
          </span>
          {#if server.connected}
            <span class="mcp-badge">
              {t.aiMcpToolCount({ count: String(server.toolCount) })}
            </span>
          {/if}
        </div>

        <p class="mcp-command">
          {server.transport === 'http' ? (server.url ?? '') : (server.command ?? '')}
        </p>
        {#if server.error}
          <p class="mcp-error">{server.error}</p>
        {/if}

        <div class="mcp-actions">
          {#if server.connected}
            <button
              type="button"
              class="mcp-secondary-button"
              disabled={busy === server.id}
              on:click={() => void disconnect(server)}
            >
              {t.aiMcpDisconnect()}
            </button>
          {:else}
            <button
              type="button"
              class="mcp-secondary-button"
              disabled={busy === server.id || server.disabled}
              on:click={() => void connect(server)}
            >
              {#if busy === server.id}
                <Loader2 size={13} class="mcp-spin" />
              {/if}
              {t.aiMcpConnect()}
            </button>
          {/if}
          <button
            type="button"
            class="mcp-secondary-button"
            disabled={busy === server.id || server.disabled}
            on:click={() => void health(server)}
          >
            {#if busy === server.id}
              <Loader2 size={13} class="mcp-spin" />
            {/if}
            {t.aiMcpHealthCheck()}
          </button>
          <label class="mcp-trust">
            <input
              type="checkbox"
              checked={server.trusted}
              disabled={busy === server.id}
              on:change={(event) => void toggleTrust(server, event.currentTarget.checked)}
            />
            <span>{t.aiMcpTrusted()}</span>
          </label>
        </div>
        <p class="mcp-hint">{t.aiMcpTrustedHint()}</p>
      </div>
    {/each}

    <div class="settings-group">
      <h2>{t.aiMcpImportTitle()}</h2>
      <p class="mcp-hint">{t.aiMcpImportDescription()}</p>
      <div class="mcp-actions">
        <button
          type="button"
          class="mcp-secondary-button"
          disabled={scanning}
          on:click={() => void scan()}
        >
          {#if scanning}
            <Loader2 size={13} class="mcp-spin" />
          {/if}
          {scanning ? t.aiMcpImportScanning() : t.aiMcpImportScan()}
        </button>
        <label class="mcp-trust">
          <input type="checkbox" bind:checked={replaceExisting} />
          <span>{t.aiMcpImportReplace()}</span>
        </label>
      </div>
      {#if sources}
        {#each sources as source (source.kind)}
          <div class="mcp-import-source">
            <div class="mcp-card-head">
              <strong>{source.label}</strong>
              {#if source.exists}
                <span class="mcp-badge">
                  {t.aiMcpImportServers({ count: String(source.servers.length) })}
                </span>
              {:else}
                <span class="mcp-badge">{t.aiMcpImportMissing()}</span>
              {/if}
            </div>
            <p class="mcp-path">{source.path}</p>
            {#if source.error}
              <p class="mcp-error">{source.error}</p>
            {/if}
            {#if source.exists}
              <div class="mcp-actions">
                <button
                  type="button"
                  class="mcp-secondary-button"
                  disabled={importing === source.kind || source.servers.length === 0}
                  on:click={() => void runImport(source)}
                >
                  {#if importing === source.kind}
                    <Loader2 size={13} class="mcp-spin" />
                  {/if}
                  {t.aiMcpImportButton()}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="settings-group">
      <p class="mcp-hint">{t.aiMcpEditHint()}</p>
      <textarea class="mcp-editor" rows="12" spellcheck="false" bind:value={draft}></textarea>
      <div class="mcp-actions">
        <button
          type="button"
          class="mcp-primary-button"
          disabled={busy === 'save'}
          on:click={() => void save()}
        >
          {#if busy === 'save'}
            <Loader2 size={13} class="mcp-spin" />
          {/if}
          {t.aiMcpSaveConfig()}
        </button>
      </div>
    </div>
  {/if}
{/if}

<style>
  .mcp-hint {
    margin: 0;
    color: var(--md-editor-muted-fg);
    line-height: 1.6;
  }

  .mcp-warning {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--md-editor-danger) 40%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--md-editor-danger) 8%, transparent);
  }

  .mcp-error {
    margin: 0;
    color: var(--md-editor-danger);
    word-break: break-word;
  }

  .mcp-ok {
    margin: 0;
    color: var(--md-editor-accent);
  }

  .mcp-path {
    font-family: var(--md-editor-font-mono);
    font-size: 12px;
    word-break: break-all;
  }

  .mcp-card {
    gap: 8px;
  }

  .mcp-import-source {
    display: grid;
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--md-editor-border);
  }

  .mcp-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mcp-badge {
    padding: 1px 7px;
    border: 1px solid var(--md-editor-border);
    border-radius: 10px;
    color: var(--md-editor-muted-fg);
    font-size: 11px;
  }

  .mcp-badge.on {
    border-color: color-mix(in srgb, var(--md-editor-accent) 55%, transparent);
    color: var(--md-editor-accent);
  }

  .mcp-command {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--md-editor-code-bg);
    color: var(--md-editor-code-fg);
    font-family: var(--md-editor-font-mono);
    font-size: 12px;
    word-break: break-all;
  }

  .mcp-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .mcp-trust {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  .mcp-editor {
    width: 100%;
    min-height: 180px;
    padding: 8px 10px;
    border: 1px solid var(--md-editor-border);
    border-radius: 6px;
    background: var(--md-editor-code-bg);
    color: var(--md-editor-code-fg);
    font-family: var(--md-editor-font-mono);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
  }

  .mcp-primary-button,
  .mcp-secondary-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 30px;
    padding: 0 12px;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }

  .mcp-primary-button {
    border: 1px solid color-mix(in srgb, var(--md-editor-accent) 65%, transparent);
    background: var(--md-editor-accent);
    color: #fff;
  }

  .mcp-secondary-button {
    border: 1px solid var(--md-editor-border);
    background: transparent;
    color: var(--md-editor-fg);
  }

  .mcp-primary-button:disabled,
  .mcp-secondary-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  :global(.mcp-spin) {
    animation: mcp-spin 1s linear infinite;
  }

  @keyframes mcp-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
