<script lang="ts">
  import { Loader2, Plus, Trash2 } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import {
    PRESET_PROVIDERS,
    createProviderFromPreset,
    normalizeAssistantPreferences,
  } from '../../../lib/assistant/config';
  import {
    deleteAssistantApiKey,
    hasAssistantApiKey,
    listProviderModels,
    loadAssistantPreferences,
    saveAssistantPreferences,
    setAssistantApiKey,
    testAssistantProvider,
  } from '../../../lib/assistant/settings';
  import type { AssistantPreferences, AssistantProviderConfig } from '../../../lib/assistant/types';
  import { isTauriRuntime } from '../../../lib/desktop/tauriStorage';
  import { t } from '../../i18n';

  /**
   * 「AI 助手」设置分区。
   *
   * 助手偏好单独存一个设置项（`assistantPreferences`），不与 AppPreferences 混在一起；
   * 这里改动立即保存，没有草稿态，避免用户填了 Key 忘记点保存。
   */

  let preferences: AssistantPreferences = normalizeAssistantPreferences(null);
  let loaded = false;
  let desktop = false;
  let errorMessage = '';
  let presetId = PRESET_PROVIDERS[0]?.id ?? '';
  let keyDrafts: Record<string, string> = {};
  let keySaved: Record<string, boolean> = {};
  let busy: Record<string, string> = {};
  let notes: Record<string, string> = {};
  let modelOptions: Record<string, string[]> = {};

  onMount(() => {
    desktop = isTauriRuntime();
    void (async () => {
      preferences = await loadAssistantPreferences();
      loaded = true;
      await refreshKeyStatus();
    })();
  });

  async function refreshKeyStatus(): Promise<void> {
    if (!desktop) {
      return;
    }
    const next: Record<string, boolean> = {};
    for (const provider of preferences.providers) {
      next[provider.id] = await hasAssistantApiKey(provider.id).catch(() => false);
    }
    keySaved = next;
  }

  async function persist(): Promise<void> {
    errorMessage = '';
    try {
      await saveAssistantPreferences(preferences);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function setBusy(id: string, label: string): void {
    busy = { ...busy, [id]: label };
  }

  function clearBusy(id: string): void {
    const next = { ...busy };
    delete next[id];
    busy = next;
  }

  function setNote(id: string, note: string): void {
    notes = { ...notes, [id]: note };
  }

  function updateProvider(id: string, patch: Partial<AssistantProviderConfig>): void {
    preferences = {
      ...preferences,
      providers: preferences.providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    };
    void persist();
  }

  function addProvider(): void {
    const provider = createProviderFromPreset(presetId, preferences.providers);
    if (!provider) {
      return;
    }
    preferences = {
      ...preferences,
      providers: [...preferences.providers, provider],
      activeProviderId: preferences.activeProviderId || provider.id,
    };
    void persist();
  }

  async function removeProvider(provider: AssistantProviderConfig): Promise<void> {
    const remaining = preferences.providers.filter((item) => item.id !== provider.id);
    preferences = {
      ...preferences,
      providers: remaining,
      activeProviderId:
        preferences.activeProviderId === provider.id
          ? (remaining[0]?.id ?? '')
          : preferences.activeProviderId,
    };
    await deleteAssistantApiKey(provider.id).catch(() => undefined);
    await persist();
    await refreshKeyStatus();
  }

  async function saveKey(provider: AssistantProviderConfig): Promise<void> {
    const apiKey = (keyDrafts[provider.id] ?? '').trim();
    if (!apiKey) {
      return;
    }
    setBusy(provider.id, 'key');
    try {
      await setAssistantApiKey(provider.id, apiKey);
      keyDrafts = { ...keyDrafts, [provider.id]: '' };
      await refreshKeyStatus();
      setNote(provider.id, t.aiSettingsKeySaved());
    } catch (error) {
      setNote(provider.id, error instanceof Error ? error.message : String(error));
    } finally {
      clearBusy(provider.id);
    }
  }

  async function clearKey(provider: AssistantProviderConfig): Promise<void> {
    setBusy(provider.id, 'key');
    try {
      await deleteAssistantApiKey(provider.id);
      await refreshKeyStatus();
      setNote(provider.id, '');
    } catch (error) {
      setNote(provider.id, error instanceof Error ? error.message : String(error));
    } finally {
      clearBusy(provider.id);
    }
  }

  async function testProvider(provider: AssistantProviderConfig): Promise<void> {
    setBusy(provider.id, 'test');
    setNote(provider.id, '');
    try {
      const result = await testAssistantProvider(provider);
      setNote(provider.id, result.ok ? t.aiSettingsTestOk() : result.message);
    } finally {
      clearBusy(provider.id);
    }
  }

  async function loadModels(provider: AssistantProviderConfig): Promise<void> {
    setBusy(provider.id, 'models');
    setNote(provider.id, '');
    try {
      const models = await listProviderModels(provider);
      modelOptions = { ...modelOptions, [provider.id]: models };
      if (models.length === 0) {
        setNote(provider.id, t.aiSettingsNoModels());
      }
    } finally {
      clearBusy(provider.id);
    }
  }

  function handleKindChange(provider: AssistantProviderConfig, event: Event): void {
    const kind = (event.currentTarget as HTMLSelectElement).value;
    updateProvider(provider.id, {
      kind: kind === 'anthropic' ? 'anthropic' : 'openai-compatible',
    });
  }

  function handleActiveChange(event: Event): void {
    const id = (event.currentTarget as HTMLSelectElement).value;
    preferences = { ...preferences, activeProviderId: id };
    void persist();
  }

  function toggleDocumentWrite(event: Event): void {
    preferences = {
      ...preferences,
      documentWriteEnabled: (event.currentTarget as HTMLInputElement).checked,
    };
    void persist();
  }

  function toggleFileWrite(event: Event): void {
    preferences = {
      ...preferences,
      fileWriteEnabled: (event.currentTarget as HTMLInputElement).checked,
    };
    void persist();
  }

  function toggleAutoCompaction(event: Event): void {
    preferences = {
      ...preferences,
      autoCompactionEnabled: (event.currentTarget as HTMLInputElement).checked,
    };
    void persist();
  }

  function toggleShell(event: Event): void {
    preferences = {
      ...preferences,
      shellEnabled: (event.currentTarget as HTMLInputElement).checked,
    };
    void persist();
  }

  function updateSkillsRoot(event: Event): void {
    preferences = {
      ...preferences,
      skillsRoot: (event.currentTarget as HTMLInputElement).value.trim(),
    };
    void persist();
  }
</script>

{#if !loaded}
  <div class="settings-group">
    <p class="ai-settings-hint">{t.aiLoading()}</p>
  </div>
{:else}
  <div class="settings-group">
    <h2>{t.aiSettingsSectionTitle()}</h2>
    <p class="ai-settings-hint">{t.aiSettingsSectionDescription()}</p>
    {#if !desktop}
      <p class="ai-settings-warning">{t.aiSettingsDesktopOnly()}</p>
    {/if}
    {#if errorMessage}
      <p class="ai-settings-error" role="alert">
        {t.aiSettingsSaveFailed({ error: errorMessage })}
      </p>
    {/if}

    <label class="toggle-row" for="assistantDocumentWrite">
      <span>
        <span class="toggle-title">{t.aiSettingsDocumentWrite()}</span>
        <span class="toggle-desc">{t.aiSettingsDocumentWriteDescription()}</span>
      </span>
      <input
        id="assistantDocumentWrite"
        type="checkbox"
        checked={preferences.documentWriteEnabled}
        on:change={toggleDocumentWrite}
      />
      <span class="toggle-switch" aria-hidden="true"></span>
    </label>

    <label class="toggle-row" for="assistantFileWrite">
      <span>
        <span class="toggle-title">{t.aiSettingsFileWrite()}</span>
        <span class="toggle-desc">{t.aiSettingsFileWriteDescription()}</span>
      </span>
      <input
        id="assistantFileWrite"
        type="checkbox"
        checked={preferences.fileWriteEnabled}
        on:change={toggleFileWrite}
      />
      <span class="toggle-switch" aria-hidden="true"></span>
    </label>

    <label class="toggle-row" for="assistantAutoCompaction">
      <span>
        <span class="toggle-title">{t.aiSettingsAutoCompaction()}</span>
        <span class="toggle-desc">{t.aiSettingsAutoCompactionDescription()}</span>
      </span>
      <input
        id="assistantAutoCompaction"
        type="checkbox"
        checked={preferences.autoCompactionEnabled}
        on:change={toggleAutoCompaction}
      />
      <span class="toggle-switch" aria-hidden="true"></span>
    </label>

    <label class="toggle-row" for="assistantShell">
      <span>
        <span class="toggle-title">{t.aiSettingsShell()}</span>
        <span class="toggle-desc">{t.aiSettingsShellDescription()}</span>
      </span>
      <input
        id="assistantShell"
        type="checkbox"
        checked={preferences.shellEnabled}
        on:change={toggleShell}
      />
      <span class="toggle-switch" aria-hidden="true"></span>
    </label>

    <label class="ai-settings-row">
      <span class="ai-settings-label">{t.aiSettingsSkillsRoot()}</span>
      <input
        type="text"
        value={preferences.skillsRoot}
        placeholder="~/.skills-manager/skills"
        on:change={updateSkillsRoot}
      />
      <span class="ai-key-hint">{t.aiSettingsSkillsRootDescription()}</span>
    </label>

    {#if preferences.providers.length > 1}
      <div class="ai-settings-row">
        <label class="ai-settings-label" for="assistantActiveProvider"
          >{t.aiSettingsActiveProvider()}</label
        >
        <select
          id="assistantActiveProvider"
          value={preferences.activeProviderId}
          on:change={handleActiveChange}
        >
          {#each preferences.providers as provider (provider.id)}
            <option value={provider.id}>{provider.name}</option>
          {/each}
        </select>
      </div>
    {/if}
  </div>

  {#if preferences.providers.length === 0}
    <div class="settings-group">
      <p class="ai-settings-hint">{t.aiSettingsNoProviders()}</p>
    </div>
  {/if}

  {#each preferences.providers as provider (provider.id)}
    <div class="settings-group ai-provider-card">
      <div class="ai-provider-head">
        <strong>{provider.name}</strong>
        <div class="ai-provider-head-actions">
          {#if keySaved[provider.id]}
            <span class="ai-key-badge">{t.aiSettingsKeyPresent()}</span>
          {/if}
          <button
            type="button"
            class="ai-danger-button"
            title={t.aiSettingsRemove()}
            on:click={() => void removeProvider(provider)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div class="ai-settings-grid">
        <label class="ai-settings-row">
          <span class="ai-settings-label">{t.aiSettingsName()}</span>
          <input
            type="text"
            value={provider.name}
            on:change={(event) => updateProvider(provider.id, { name: event.currentTarget.value })}
          />
        </label>
        <label class="ai-settings-row">
          <span class="ai-settings-label">{t.aiSettingsKind()}</span>
          <select value={provider.kind} on:change={(event) => handleKindChange(provider, event)}>
            <option value="openai-compatible">{t.aiSettingsOpenAiCompatible()}</option>
            <option value="anthropic">{t.aiSettingsAnthropic()}</option>
          </select>
        </label>
        <label class="ai-settings-row ai-settings-wide">
          <span class="ai-settings-label">{t.aiSettingsBaseUrl()}</span>
          <input
            type="url"
            value={provider.baseUrl}
            on:change={(event) =>
              updateProvider(provider.id, { baseUrl: event.currentTarget.value })}
          />
        </label>
        <label class="ai-settings-row ai-settings-wide">
          <span class="ai-settings-label">{t.aiSettingsModel()}</span>
          <input
            type="text"
            list={`models-${provider.id}`}
            value={provider.model}
            on:change={(event) => updateProvider(provider.id, { model: event.currentTarget.value })}
          />
          <datalist id={`models-${provider.id}`}>
            {#each modelOptions[provider.id] ?? [] as model (model)}
              <option value={model}></option>
            {/each}
          </datalist>
        </label>
      </div>

      <div class="ai-settings-row">
        <span class="ai-settings-label">{t.aiSettingsApiKey()}</span>
        <div class="ai-key-row">
          <input
            type="password"
            autocomplete="off"
            placeholder={keySaved[provider.id]
              ? t.aiSettingsApiKeyReplace()
              : t.aiSettingsApiKeyPlaceholder()}
            value={keyDrafts[provider.id] ?? ''}
            on:input={(event) =>
              (keyDrafts = { ...keyDrafts, [provider.id]: event.currentTarget.value })}
          />
          <button
            type="button"
            class="ai-primary-button"
            disabled={!desktop || busy[provider.id] === 'key' || !(keyDrafts[provider.id] ?? '').trim()}
            on:click={() => void saveKey(provider)}
          >
            {t.aiSettingsSaveKey()}
          </button>
          {#if keySaved[provider.id]}
            <button
              type="button"
              class="ai-secondary-button"
              disabled={!desktop || busy[provider.id] === 'key'}
              on:click={() => void clearKey(provider)}
            >
              {t.aiSettingsDeleteKey()}
            </button>
          {/if}
        </div>
      </div>

      <div class="ai-provider-actions">
        <button
          type="button"
          class="ai-secondary-button"
          disabled={!desktop || busy[provider.id] === 'test'}
          on:click={() => void testProvider(provider)}
        >
          {#if busy[provider.id] === 'test'}
            <Loader2 size={13} class="ai-spin" />
          {/if}
          {t.aiSettingsTest()}
        </button>
        {#if provider.kind !== 'anthropic'}
          <button
            type="button"
            class="ai-secondary-button"
            disabled={!desktop || busy[provider.id] === 'models'}
            on:click={() => void loadModels(provider)}
          >
            {#if busy[provider.id] === 'models'}
              <Loader2 size={13} class="ai-spin" />
            {/if}
            {t.aiSettingsLoadModels()}
          </button>
        {/if}
        {#if notes[provider.id]}
          <span class="ai-provider-note">{notes[provider.id]}</span>
        {/if}
      </div>
    </div>
  {/each}

  <div class="settings-group">
    <h2>{t.aiSettingsAddProvider()}</h2>
    <div class="ai-add-row">
      <select bind:value={presetId}>
        {#each PRESET_PROVIDERS as preset (preset.id)}
          <option value={preset.id}>{preset.name}</option>
        {/each}
      </select>
      <button type="button" class="ai-primary-button" on:click={addProvider}>
        <Plus size={14} />
        {t.aiSettingsAdd()}
      </button>
    </div>
  </div>
{/if}

<style>
  .ai-settings-hint {
    margin: 0;
    color: var(--md-editor-muted-fg);
    line-height: 1.6;
  }

  .ai-settings-warning {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--md-editor-danger) 40%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--md-editor-danger) 8%, transparent);
  }

  .ai-settings-error {
    margin: 0;
    color: var(--md-editor-danger);
  }

  .ai-provider-card {
    gap: 10px;
  }

  .ai-provider-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .ai-provider-head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ai-key-badge {
    padding: 1px 6px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--md-editor-accent) 15%, transparent);
    color: var(--md-editor-accent);
    font-size: 11px;
  }

  .ai-settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .ai-settings-wide {
    grid-column: 1 / -1;
  }

  .ai-settings-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ai-settings-label {
    color: var(--md-editor-muted-fg);
    font-size: 12px;
  }

  .ai-key-hint {
    color: var(--md-editor-muted-fg);
    font-size: 12px;
    line-height: 1.5;
  }

  .ai-settings-row input,
  .ai-settings-row select,
  .ai-add-row select {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--md-editor-border);
    border-radius: 6px;
    background: var(--md-editor-bg);
    color: var(--md-editor-fg);
    font: inherit;
  }

  .ai-key-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ai-key-row input {
    flex: 1 1 auto;
  }

  .ai-provider-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .ai-provider-note {
    color: var(--md-editor-muted-fg);
    font-size: 12px;
    word-break: break-word;
  }

  .ai-add-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-primary-button,
  .ai-secondary-button,
  .ai-danger-button {
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

  .ai-primary-button {
    border: 1px solid color-mix(in srgb, var(--md-editor-accent) 65%, transparent);
    background: var(--md-editor-accent);
    color: #fff;
  }

  .ai-primary-button:disabled,
  .ai-secondary-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ai-secondary-button {
    border: 1px solid var(--md-editor-border);
    background: transparent;
    color: var(--md-editor-fg);
  }

  .ai-danger-button {
    width: 28px;
    padding: 0;
    border: 1px solid transparent;
    background: transparent;
    color: var(--md-editor-muted-fg);
  }

  .ai-danger-button:hover {
    color: var(--md-editor-danger);
    background: var(--md-editor-hover-bg);
  }

  :global(.ai-spin) {
    animation: ai-spin 1s linear infinite;
  }

  @keyframes ai-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
