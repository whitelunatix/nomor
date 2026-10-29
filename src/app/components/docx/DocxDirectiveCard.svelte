<script lang="ts">
  import { Plus, Trash2, X } from '@lucide/svelte';
  import type { DocxEdit } from '../../../lib/docxmd/directivePatch';
  import { docxFieldLabel, docxFieldSchema } from '../../../lib/docxmd/fieldSchema';
  import type { DocxContextDirectiveView, DocxContextFieldView } from '../../../lib/docxmd/inspector';
  import { t } from '../../i18n';

  export let directive: DocxContextDirectiveView;
  export let targetId: string;
  export let readonly = false;
  export let applyEdits: (targetId: string, edits: DocxEdit[]) => boolean;

  let addingGroup = -1;
  let newFieldName = '';
  let newFieldValue = '';
  let rawOpen = false;

  $: keywordLabel = directive.globalTarget
    ? `${directive.keyword}.${directive.globalTarget}`
    : directive.keyword;

  function commit(edit: DocxEdit): void {
    applyEdits(targetId, [edit]);
  }

  function commitField(field: DocxContextFieldView, value: string): void {
    commit({
      type: 'setField',
      lineIndex: directive.lineIndex,
      groupIndex: field.groupIndex,
      fieldIndex: field.fieldIndex,
      value,
    });
  }

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value;
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function checkboxValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).checked ? 'true' : 'false';
  }

  function colorInput(value: string): string {
    return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : '#000000';
  }

  function startAddField(groupIndex: number): void {
    addingGroup = groupIndex;
    newFieldName = '';
    newFieldValue = '';
  }

  function submitField(groupIndex: number): void {
    const name = newFieldName.trim();
    if (!name) return;
    const ok = applyEdits(targetId, [
      {
        type: 'addField',
        lineIndex: directive.lineIndex,
        groupIndex,
        name,
        value: newFieldValue,
      },
    ]);
    if (ok) addingGroup = -1;
  }

  function removeDirective(): void {
    commit({ type: 'removeDirective', lineIndex: directive.lineIndex });
  }
</script>

<article class="docx-directive-card" class:invalid={!directive.valid}>
  <header class="docx-directive-head">
    <span class="docx-directive-keyword">{keywordLabel}</span>
    <span class="docx-directive-line">{t.docxDirectiveLine({ line: directive.lineIndex + 1 })}</span>
    <button
      type="button"
      class="docx-icon-button"
      title={t.docxRemove()}
      aria-label={t.docxRemove()}
      disabled={readonly}
      on:click={removeDirective}
    >
      <Trash2 size={13} />
    </button>
  </header>

  {#if directive.diagnostics.length > 0}
    <ul class="docx-diagnostics">
      {#each directive.diagnostics as diagnostic}
        <li class:error={diagnostic.severity === 'error'}>{diagnostic.message}</li>
      {/each}
    </ul>
  {/if}

  {#each directive.groups as group, groupIndex}
    <section class="docx-field-group">
      <div class="docx-group-label">
        {group.rawKeyword || group.canonicalKeyword}
        {#if group.globalTarget}<span class="docx-group-target">global.{group.globalTarget}</span>{/if}
      </div>
      {#if group.fields.length === 0}
        <p class="docx-empty-hint">（空）</p>
      {:else}
        {#each group.fields as field (field.fieldIndex)}
          {@const schema = docxFieldSchema(
            group.canonicalKeyword || directive.canonicalKeyword,
            field.canonicalName,
          )}
          <div class="docx-field-row">
            <span class="docx-field-label" title={`${field.rawName}${schema.placeholder ? ` · ${schema.placeholder}` : ''}`}>
              {docxFieldLabel(field.canonicalName)}
            </span>
            {#if schema.control === 'enum'}
              <select
                class="docx-field-control"
                value={field.value}
                disabled={readonly}
                on:change={(event) => commitField(field, selectValue(event))}
              >
                {#if field.value && !schema.options?.some((option) => option.value === field.value)}
                  <option value={field.value}>{field.value}</option>
                {/if}
                {#each schema.options ?? [] as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            {:else if schema.control === 'boolean'}
              <input
                class="docx-field-checkbox"
                type="checkbox"
                checked={field.rawValue === '' || /^(true|1|yes|on)$/i.test(field.value)}
                disabled={readonly}
                on:change={(event) => commitField(field, checkboxValue(event))}
              />
            {:else if schema.control === 'color'}
              <span class="docx-color-field">
                <input
                  class="docx-color-picker"
                  type="color"
                  value={colorInput(field.value)}
                  disabled={readonly}
                  on:change={(event) => commitField(field, inputValue(event))}
                />
                <input
                  class="docx-field-control"
                  type="text"
                  value={field.value}
                  placeholder="#000000"
                  spellcheck="false"
                  disabled={readonly}
                  on:change={(event) => commitField(field, inputValue(event))}
                />
              </span>
            {:else}
              <input
                class="docx-field-control"
                type={schema.control === 'number' ? 'number' : 'text'}
                value={field.value}
                placeholder={schema.placeholder ?? ''}
                spellcheck="false"
                disabled={readonly}
                on:change={(event) => commitField(field, inputValue(event))}
              />
            {/if}
            <button
              type="button"
              class="docx-icon-button"
              title={t.docxRemoveField()}
              aria-label={t.docxRemoveField()}
              disabled={readonly}
              on:click={() =>
                commit({
                  type: 'removeField',
                  lineIndex: directive.lineIndex,
                  groupIndex: field.groupIndex,
                  fieldIndex: field.fieldIndex,
                })}
            >
              <X size={12} />
            </button>
          </div>
        {/each}
      {/if}

      {#if !readonly && group.fields.length > 0}
        {#if addingGroup === groupIndex}
          <div class="docx-add-field">
            <input
              class="docx-field-control"
              bind:value={newFieldName}
              placeholder={t.docxFieldName()}
              spellcheck="false"
            />
            <input
              class="docx-field-control"
              bind:value={newFieldValue}
              placeholder={t.docxFieldValue()}
              spellcheck="false"
              on:keydown={(event) => event.key === 'Enter' && submitField(groupIndex)}
            />
            <button type="button" class="docx-icon-button" title={t.docxApply()} on:click={() => submitField(groupIndex)}>
              <Plus size={13} />
            </button>
            <button type="button" class="docx-icon-button" title={t.cancel()} on:click={() => (addingGroup = -1)}>
              <X size={13} />
            </button>
          </div>
        {:else}
          <button type="button" class="docx-add-field-trigger" on:click={() => startAddField(groupIndex)}>
            <Plus size={12} />
            {t.docxAddField()}
          </button>
        {/if}
      {/if}
    </section>
  {/each}

  <details class="docx-directive-raw" bind:open={rawOpen}>
    <summary>{t.docxRawDirective()}</summary>
    <code>{directive.raw}</code>
  </details>
</article>
