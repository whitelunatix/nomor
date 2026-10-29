import { describe, expect, it, vi } from 'vitest';
import type { EditorCore } from '../../lib/editor-core';
import type { MarkdownSourceEditorHandle } from '../components/markdownSourceEditor';
import {
  insertEmojiAtTarget,
  type EmojiInsertionContext,
  type EmojiInsertionTarget,
} from './emojiInsertion';

function setup(sourceMode = false) {
  const editor = {
    getSnapshot: vi.fn(() => ({ version: 10, contentRevision: 2 })),
    restoreSelectionSnapshot: vi.fn(),
    execute: vi.fn(() => true),
    focus: vi.fn(),
  } as unknown as EditorCore;
  const source = {
    replaceRange: vi.fn(() => true),
    focus: vi.fn(),
  } as unknown as MarkdownSourceEditorHandle;
  const target: EmojiInsertionTarget = {
    tabId: 'left',
    editor,
    source: sourceMode ? source : undefined,
    mode: sourceMode ? 'source' : 'semantic',
    viewMode: 'split',
    pane: sourceMode ? 'source' : 'semantic',
    selection: { anchor: 8, head: 4 },
    contentRevision: 2,
  };
  const current: EmojiInsertionContext = {
    tabId: 'left',
    editor,
    source,
    viewMode: 'split',
    pane: target.pane,
    readonly: false,
    disabled: false,
    runtimeAvailable: true,
  };
  return { target, current, editor, source };
}

describe('emoji insertion target safety', () => {
  it.each([
    { tabId: 'right' },
    { pane: 'source' },
    { viewMode: 'source' },
    { readonly: true },
    { disabled: true },
    { runtimeAvailable: false },
  ] as Partial<EmojiInsertionContext>[])(
    'cancels after the document, split side or permissions change: %o',
    (change) => {
      const { target, current, editor } = setup();
      expect(insertEmojiAtTarget(target, { ...current, ...change }, '😄')).toBe(false);
      expect(editor.execute).not.toHaveBeenCalled();
      expect(editor.restoreSelectionSnapshot).not.toHaveBeenCalled();
    },
  );
  it('rejects a replaced editor runtime or changed semantic revision', () => {
    const { target, current, editor } = setup();
    expect(insertEmojiAtTarget(target, { ...current, editor: {} as EditorCore }, '😄')).toBe(false);
    target.contentRevision = 1;
    expect(insertEmojiAtTarget(target, current, '😄')).toBe(false);
    expect(editor.execute).not.toHaveBeenCalled();
  });
  it('restores only the semantic selection and inserts into the captured comparison document', () => {
    const { target, current, editor } = setup();
    expect(insertEmojiAtTarget(target, current, '😄')).toBe(true);
    expect(editor.restoreSelectionSnapshot).toHaveBeenCalledWith({ anchor: 8, head: 4 });
    expect(editor.execute).toHaveBeenCalledWith({ type: 'insertText', text: '😄' });
  });
  it('uses the source transaction with revision validation and avoids semantic insertion', () => {
    const { target, current, editor, source } = setup(true);
    expect(insertEmojiAtTarget(target, current, '😄')).toBe(true);
    expect(source.replaceRange).toHaveBeenCalledWith(4, 8, '😄', 2);
    expect(editor.execute).not.toHaveBeenCalled();
    expect(insertEmojiAtTarget(target, { ...current, source: undefined }, '😄')).toBe(false);
    source.getSelectionStatsSnapshot = () => ({
      documentId: 'right',
      from: 4,
      to: 8,
      contentRevision: 2,
    });
    expect(insertEmojiAtTarget(target, current, '😄')).toBe(false);
    source.getSelectionStatsSnapshot = () => ({
      documentId: 'left',
      from: 4,
      to: 8,
      contentRevision: 2,
    });
    vi.mocked(source.replaceRange!).mockReturnValue(false);
    expect(insertEmojiAtTarget(target, current, '😄')).toBe(false);
  });
});
