import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../editor-core/markdown';
import {
  REBUILD_SEMANTIC_LINE_NUMBERS,
  buildSemanticLineNumberDecorations,
  semanticLineNumbersPlugin,
  semanticLineNumbersPluginKey,
} from './semanticLineNumbers';

interface Decorated {
  from: number;
  attrs: Record<string, string>;
  node: ProseMirrorNode | null;
}

function decorationsFor(markdown: string, docx = false): Decorated[] {
  const doc = parseMarkdown(markdown, { docx });
  const set = buildSemanticLineNumberDecorations(doc, markdown, docx);
  return set.find().map((decoration) => ({
    from: decoration.from,
    attrs: { ...((decoration.spec?.attrs ?? {}) as Record<string, string>) },
    node: doc.nodeAt(decoration.from),
  }));
}

describe('semantic line numbers', () => {
  it('labels every top-level block with its source line', () => {
    const entries = decorationsFor(['# 标题', '', '正文', '', '- 一', '- 二'].join('\n'));

    // 空行不占号：三个块是第 1、2、3 条有效行。
    expect(entries.map((entry) => entry.attrs['data-nomo-line'])).toEqual(['1', '2', '3']);
    expect(entries.map((entry) => entry.node?.type.name)).toEqual([
      'heading',
      'paragraph',
      'bullet_list',
    ]);
    expect(entries.every((entry) => entry.attrs.class === 'nomo-line-numbered')).toBe(true);
  });

  it('uses the same source mapping as line navigation in docx mode', () => {
    const entries = decorationsFor(
      ['<!-- paragraph | align: justify -->', '正文', '', '第二段'].join('\n'),
      true,
    );

    // 指令行由 docx 解析器吃掉、也不占号：两段正文是第 1、2 条有效行。
    expect(entries[0]?.attrs['data-nomo-line']).toBe('1');
    expect(entries[1]?.attrs['data-nomo-line']).toBe('2');
  });

  it('skips blocks whose ::before is already taken by another style', () => {
    const entries = decorationsFor(['> 引用', '', '正文'].join('\n'));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.node?.type.name).toBe('paragraph');
    expect(entries[0]?.attrs['data-nomo-line']).toBe('2');
  });

  it('returns an empty decoration set for empty documents', () => {
    expect(decorationsFor('')).toEqual([]);
  });

  it('rebuilds decorations when the toggle flips', () => {
    const markdown = ['# 标题', '', '正文'].join('\n');
    let enabled = false;
    const plugin = semanticLineNumbersPlugin({
      enabled: () => enabled,
      docxMode: () => false,
      getMarkdown: () => markdown,
    });
    let state = EditorState.create({ doc: parseMarkdown(markdown), plugins: [plugin] });

    expect(semanticLineNumbersPluginKey.getState(state)?.find()).toHaveLength(0);

    enabled = true;
    state = state.apply(
      state.tr.setMeta(semanticLineNumbersPluginKey, REBUILD_SEMANTIC_LINE_NUMBERS),
    );
    expect(semanticLineNumbersPluginKey.getState(state)?.find()).toHaveLength(2);

    enabled = false;
    state = state.apply(
      state.tr.setMeta(semanticLineNumbersPluginKey, REBUILD_SEMANTIC_LINE_NUMBERS),
    );
    expect(semanticLineNumbersPluginKey.getState(state)?.find()).toHaveLength(0);
  });
});
