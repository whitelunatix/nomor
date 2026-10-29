import { cleanup, fireEvent, render } from '@testing-library/svelte/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DocumentTabs from './DocumentTabs.svelte';
import type { MarkdownTabState } from '../types';

function createTab(id: string, overrides: Partial<MarkdownTabState> = {}): MarkdownTabState {
  return {
    id,
    fileName: `${id}.md`,
    filePath: `C:/docs/${id}.md`,
    nativePath: `C:/docs/${id}.md`,
    dirty: false,
    lastKnownModifiedAt: 0,
    diskReadonly: false,
    externalFileChange: null,
    documentKind: 'markdown',
    draftId: null,
    markdown: '# 标题',
    savedMarkdown: '# 标题',
    largeDocumentMode: false,
    readonlyDocumentMode: false,
    version: 1,
    ...overrides,
  } as MarkdownTabState;
}

function renderTabs(options: { tabs?: MarkdownTabState[]; workspaceInteractionDisabled?: boolean } = {}) {
  const closeTab = vi.fn();
  const switchTab = vi.fn();
  const rendered = render(DocumentTabs, {
    props: {
      interfaceLocale: 'zh-CN',
      tabs: options.tabs ?? [createTab('one')],
      activeTabId: 'one',
      switchTab,
      closeTab,
      pinPreviewTab: vi.fn(),
      createNewFile: vi.fn(),
      workspaceInteractionDisabled: options.workspaceInteractionDisabled ?? false,
    },
  });
  return { ...rendered, closeTab, switchTab };
}

/**
 * 取真正可交互的标签。
 *
 * 标签先渲染在隐藏的测量区，卡片宽度量完后才进入 .tabs-container，
 * 因此这里轮询等待，并跳过测量区里的副本。
 */
async function tabElement(container: HTMLElement): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tab = container.querySelector<HTMLElement>('.tabs-container .doc-tab');
    if (tab) return tab;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  throw new Error('tab element missing');
}

afterEach(() => {
  cleanup();
});

describe('DocumentTabs middle click', () => {
  it('closes the tab through the normal close flow', async () => {
    const { container, closeTab } = renderTabs();

    const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    await fireEvent(await tabElement(container), event);

    expect(event.defaultPrevented).toBe(true);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith('one', event);
  });

  it('prevents the browser autoscroll on middle mousedown', async () => {
    const { container } = renderTabs();

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    await fireEvent(await tabElement(container), event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores middle clicks while workspace interaction is disabled', async () => {
    const { container, closeTab } = renderTabs({ workspaceInteractionDisabled: true });

    await fireEvent(
      await tabElement(container),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );

    expect(closeTab).not.toHaveBeenCalled();
  });
});
