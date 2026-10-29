import { describe, expect, it, vi } from 'vitest';
import { createEditorCore } from './createEditorCore';

describe('EditorCore block alignment decorations', () => {
  it('adds and clears semantic spacers without changing Markdown, version, dirty state, or history', () => {
    const target = document.createElement('div');
    const onChange = vi.fn();
    const editor = createEditorCore({ markdown: '# Title\n\nBody', target, onChange });
    const before = editor.getSnapshot();
    onChange.mockClear();
    const blocks = target.querySelectorAll<HTMLElement>('.ProseMirror > *');
    blocks[0].style.marginBottom = '20px';
    blocks[1].style.marginTop = '12px';

    editor.applyBlockAlignmentGaps([{ key: 'node:0', nodeIndex: 0, height: 32 }]);

    const spacer = target.querySelector<HTMLElement>('.semantic-block-alignment-spacer');
    expect(spacer).not.toBeNull();
    expect(spacer?.parentElement?.classList.contains('ProseMirror')).toBe(true);
    expect(spacer?.style.height).toBe('32px');
    expect(spacer?.style.marginTop).toBe('-12px');
    expect(editor.getMarkdown()).toBe('# Title\n\nBody');
    expect(editor.getSnapshot()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.execute({ type: 'undo' })).toBe(false);

    editor.clearBlockAlignmentGaps();
    expect(target.querySelector('.semantic-block-alignment-spacer')).toBeNull();
    expect(editor.getSnapshot()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
    editor.destroy();
  });

  it('does not insert a spacer after the final semantic block', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({ markdown: 'Only paragraph', target });

    editor.applyBlockAlignmentGaps([{ key: 'node:0', nodeIndex: 0, height: 48 }]);

    expect(target.querySelector('.semantic-block-alignment-spacer')).toBeNull();
    expect(editor.getMarkdown()).toBe('Only paragraph');
    editor.destroy();
  });
});
