import { describe, expect, it } from 'vitest';
import { history, undo } from 'prosemirror-history';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { moveImageTransaction } from './imageDrag';
import { schema } from './schema';

const image = () =>
  schema.nodes.image.create({
    src: './assets/a.png',
    alt: '图',
    title: '标题',
    width: '60%',
    align: 'center',
  });

const paragraph = (...children: ProseMirrorNode[]) =>
  schema.node('paragraph', null, children);

function createDoc() {
  return schema.node('doc', null, [
    paragraph(schema.text('前')),
    paragraph(image()),
    paragraph(schema.text('后')),
  ]);
}

function findImagePosition(doc: ReturnType<typeof createDoc>): number {
  let found = -1;
  doc.descendants((node, position) => {
    if (node.type.name === 'image') {
      found = position;
      return false;
    }
    return true;
  });
  return found;
}

describe('moveImageTransaction', () => {
  it('把图片移动到其它段落并保留全部属性', () => {
    const doc = createDoc();
    const position = findImagePosition(doc);
    const thirdParagraph = doc.child(0).nodeSize + doc.child(1).nodeSize;
    const state = EditorState.create({ doc });

    const transaction = moveImageTransaction(state, position, thirdParagraph + 2);
    expect(transaction).not.toBeNull();
    const moved = state.apply(transaction!);
    const blocks = Array.from({ length: moved.doc.childCount }, (_, index) =>
      moved.doc.child(index),
    );

    expect(blocks[0].textContent).toBe('前');
    expect(blocks[1].childCount).toBe(0);
    expect(blocks[2].textContent).toBe('后');
    const movedImage = blocks[2].lastChild!;
    expect(movedImage.type.name).toBe('image');
    expect(movedImage.attrs).toEqual(doc.child(1).child(0).attrs);
    expect(transaction!.steps.length).toBeGreaterThan(0);
  });

  it('一次撤销即可恢复图片原位', () => {
    const doc = createDoc();
    const position = findImagePosition(doc);
    const thirdParagraph = doc.child(0).nodeSize + doc.child(1).nodeSize;
    let state = EditorState.create({ doc, plugins: [history()] });
    const transaction = moveImageTransaction(state, position, thirdParagraph + 2)!;

    state = state.apply(transaction);
    expect(state.doc.eq(doc)).toBe(false);

    const restored: EditorState[] = [];
    undo(state, (undoTransaction) => {
      restored.push(state.apply(undoTransaction));
    });
    expect(restored[0]?.doc.eq(doc)).toBe(true);
  });

  it('拒绝落到自身范围或块边界', () => {
    const doc = createDoc();
    const position = findImagePosition(doc);
    const state = EditorState.create({ doc });
    const blockBoundary = doc.child(0).nodeSize;

    expect(moveImageTransaction(state, position, position)).toBeNull();
    expect(moveImageTransaction(state, position, position + 1)).toBeNull();
    expect(moveImageTransaction(state, position, blockBoundary)).toBeNull();
  });
});
