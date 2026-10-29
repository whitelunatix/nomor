import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { parseMarkdown } from '../markdown';
import { schema } from '../schema';
import { docxAttrGuardPlugin } from './docxAttrGuard';

function paragraphPosition(doc: ReturnType<typeof parseMarkdown>): number {
  let position = -1;
  doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph' && position < 0) position = offset;
  });
  return position;
}

describe('docxAttrGuard', () => {
  it('restores docxPrefix when a paragraph becomes a heading', () => {
    const doc = parseMarkdown('<!-- font | mix: 宋体 10.5pt -->\n正文', { docx: true });
    const position = paragraphPosition(doc);
    const state = EditorState.create({ doc, plugins: [docxAttrGuardPlugin()] });

    const next = state.apply(state.tr.setNodeMarkup(position, schema.nodes.heading, { level: 2 }));
    const heading = next.doc.nodeAt(position);

    expect(heading?.type.name).toBe('heading');
    expect(heading?.attrs.docxPrefix).toEqual(['<!-- font | mix: 宋体 10.5pt -->']);
  });

  it('restores docxPrefix when a heading becomes a paragraph', () => {
    const doc = parseMarkdown('<!-- paragraph | align: center -->\n# 标题', { docx: true });
    let position = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === 'heading') position = offset;
    });
    const state = EditorState.create({ doc, plugins: [docxAttrGuardPlugin()] });

    const next = state.apply(state.tr.setNodeMarkup(position, schema.nodes.paragraph, {}));
    const paragraph = next.doc.nodeAt(position);

    expect(paragraph?.type.name).toBe('paragraph');
    expect(paragraph?.attrs.docxPrefix).toEqual(['<!-- paragraph | align: center -->']);
  });

  it('leaves ordinary markdown untouched', () => {
    const doc = parseMarkdown('正文');
    let position = -1;
    doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') position = offset;
    });
    const state = EditorState.create({ doc, plugins: [docxAttrGuardPlugin()] });

    const next = state.apply(state.tr.setNodeMarkup(position, schema.nodes.heading, { level: 2 }));
    expect(next.doc.nodeAt(position)?.attrs.docxPrefix).toBeNull();
  });
});
