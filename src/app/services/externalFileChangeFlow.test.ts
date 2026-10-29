import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('external file change flow', () => {
  const actionsSource = readFileSync(resolve(__dirname, 'documentActionsController.ts'), 'utf-8');
  const appSource = readFileSync(resolve(__dirname, '../App.svelte'), 'utf-8');
  const dialogSource = readFileSync(
    resolve(__dirname, '../components/ExternalChangeDialog.svelte'),
    'utf-8',
  );

  it('blocks ordinary save and autosave while an external change is pending', () => {
    const saveStart = actionsSource.indexOf('async function saveMarkdownFile');
    const saveEnd = actionsSource.indexOf('async function openRecentFile');
    const saveSource = actionsSource.slice(saveStart, saveEnd);

    // 保存可能指定目标标签页，所以按目标标签自己的变更状态判断，不能只看当前活动页。
    expect(saveSource).toContain("!saveAsTarget && activeTab.externalFileChange.type !== 'none'");
    expect(saveSource).toContain('t.externalChangeChooseAction()');

    const autosaveStart = actionsSource.indexOf('function debouncedAutoSave');
    const autosaveEnd = actionsSource.indexOf('function cancelPendingAutoSaves');
    const autosaveSource = actionsSource.slice(autosaveStart, autosaveEnd);

    expect(autosaveSource.match(/hasExternalFileChange\(\)/g)).toHaveLength(2);
    expect(autosaveSource).toContain('t.externalChangeAutoSavePaused()');
  });

  it('supports a persisted default action before opening the external change dialog', () => {
    expect(appSource).toContain('externalFileChangeBehavior');
    expect(appSource).toContain('tryHandleExternalFileChangeByPreference');
    expect(appSource).toContain("case 'reload-external'");
    expect(appSource).toContain("case 'ignore'");
    expect(appSource).toContain("case 'overwrite-external'");
  });

  it('keeps segmented conflicts active when the default action ignores one disk identity', () => {
    expect(appSource).toContain('function ignoreSegmentedExternalChange(');
    expect(appSource).toContain('ignoredSegmentedExternalChanges.set(sessionId, changeToken);');
    expect(appSource).toMatch(
      /case 'ignore':[\s\S]*?ignoreSegmentedExternalChange\([\s\S]*?segmentedIgnoreTarget\.changeToken/,
    );
    expect(appSource).toContain(
      'tryHandleExternalFileChangeByPreference(change, segmentedIgnoreTarget)',
    );
  });

  it('exposes explicit reload, save-as and overwrite actions in the editor alert', () => {
    expect(actionsSource).toContain('async function reloadExternalFile');
    expect(actionsSource).toContain('async function overwriteExternalFile');
    // 覆盖写只对「磁盘已修改」或「磁盘已删除」两种冲突开放，其它状态给出可读提示。
    const overwriteStart = actionsSource.indexOf('async function overwriteExternalFile');
    const overwriteEnd = actionsSource.indexOf('let saveTimers', overwriteStart);
    const overwriteSource = actionsSource.slice(overwriteStart, overwriteEnd);
    expect(overwriteSource).toContain(
      "if (externalChangeType !== 'modified' && externalChangeType !== 'deleted')",
    );
    expect(overwriteSource).toContain('t.noExternalChangeToOverwrite()');

    // 冲突对话框是唯一入口：三个显式动作各自绑定一个处理函数，删除分支单独给出重建。
    expect(dialogSource).toContain("change.type === 'deleted'");
    expect(dialogSource).toContain('on:click={onReload}');
    expect(dialogSource).toContain('t.reloadExternalShort()');
    expect(dialogSource).toContain('on:click={onSaveAs}');
    expect(dialogSource).toContain('t.saveAs()');
    expect(dialogSource).toContain('on:click={onOverwrite}');
    expect(dialogSource).toContain('t.overwriteExternalShort()');
    expect(dialogSource).toContain('t.recreateOriginalFile()');
    expect(appSource).toContain('<ExternalChangeDialog');
    expect(appSource).toContain('onReload={handleExternalChangeReload}');
    expect(appSource).toContain('onOverwrite={handleExternalChangeOverwrite}');
    expect(appSource).toContain('onSaveAs={handleExternalChangeSaveAs}');
  });
});
