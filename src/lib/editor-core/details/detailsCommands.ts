import { Fragment, type Node as PmNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { NodeSelection, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { detailsHistoryBoundary, detailsKey, detailsParent } from './detailsState';
import { CodeBlockNodeView } from '../nodeViews/CodeBlockNodeView';

export const insertDetails: Command = (state, dispatch) => {
  const { schema, selection } = state;
  if (selection.$from.parent.type.name === 'details_summary') return false;
  const node = schema.nodes.details.create(null, [schema.nodes.details_summary.create(),
    schema.nodes.details_body.create(null, schema.nodes.paragraph.create())]);
  const tr = closeHistory(state.tr);
  if (selection.empty && selection.$from.parent.type.name === 'paragraph' && !selection.$from.parent.content.size) {
    tr.replaceWith(selection.$from.before(), selection.$from.after(), node);
  } else tr.replaceSelectionWith(node);
  let pos: number | undefined;
  tr.mapping.maps.forEach((map, index) => map.forEach((_a, _b, from, to) => {
    const mapping = tr.mapping.slice(index + 1);
    tr.doc.nodesBetween(mapping.map(from, -1), mapping.map(to, 1), (child, offset) => {
      if (child.type.name === 'details' && pos === undefined) pos = offset;
    });
  }));
  if (pos === undefined) return false;
  tr.setSelection(TextSelection.create(tr.doc, pos + 2));
  tr.setMeta(detailsKey, { pos, open: true });
  tr.setMeta(detailsHistoryBoundary, true);
  dispatch?.(tr.scrollIntoView());
  return true;
};

function target(state: EditorState, pos?: number): { pos: number; node: PmNode } | null {
  if (pos === undefined) return detailsParent(state);
  const node = state.doc.nodeAt(pos);
  return node?.type.name === 'details' ? { pos, node } : null;
}

export const setDetailsDefaultOpen = (open: boolean, pos?: number): Command => (state, dispatch) => {
  const found = target(state, pos);
  if (!found) return false;
  const tr = closeHistory(state.tr).setNodeMarkup(found.pos, undefined, { ...found.node.attrs, defaultOpen: open });
  if (!open && [state.selection.anchor, state.selection.head].some(position =>
    position > found.pos + found.node.firstChild!.nodeSize && position < found.pos + found.node.nodeSize)) {
    tr.setSelection(TextSelection.create(tr.doc, found.pos + 2));
  }
  dispatch?.(tr.setMeta(detailsKey, { pos: found.pos, open, collapse: !open, reset: true })
    .setMeta(detailsHistoryBoundary, true).scrollIntoView());
  return true;
};

export const unwrapDetails = (pos?: number): Command => (state, dispatch) => {
  const found = target(state, pos);
  if (!found) return false;
  const summary = found.node.firstChild!;
  const blocks = summary.content.size
    ? Fragment.from(state.schema.nodes.paragraph.create(null, summary.content)).append(found.node.lastChild!.content)
    : found.node.lastChild!.content;
  const tr = closeHistory(state.tr).replaceWith(found.pos, found.pos + found.node.nodeSize, blocks);
  tr.setMeta(detailsHistoryBoundary, true);
  dispatch?.(tr.setSelection(TextSelection.near(tr.doc.resolve(found.pos), 1)).scrollIntoView());
  return true;
};

export const enterDetailsBody: Command = (state, dispatch, view) => {
  if (state.selection.$from.parent.type.name !== 'details_summary') return false;
  const found = detailsParent(state)!;
  const start = found.pos + 1 + found.node.firstChild!.nodeSize + 1;
  const code = state.doc.nodeAt(start)?.type.name === 'code_block';
  dispatch?.(state.tr.setSelection(code ? NodeSelection.create(state.doc, start) : TextSelection.near(state.doc.resolve(start), 1))
    .setMeta(detailsKey, { pos: found.pos, open: true }).setMeta('addToHistory', false).scrollIntoView());
  if (code && view && dispatch) CodeBlockNodeView.enterEditAt(view, start, 0, 'start');
  return true;
};

export const exitDetails = (before = false): Command => (state, dispatch) => {
  const found = detailsParent(state);
  if (!found) return false;
  const pos = before ? found.pos : found.pos + found.node.nodeSize;
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), state.schema.nodes.paragraph)) return false;
  const tr = closeHistory(state.tr).insert(pos, state.schema.nodes.paragraph.create());
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
  return true;
};

export const exitDetailsEmptyParagraph: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size ||
    $from.node($from.depth - 1).type.name !== 'details_body' || $from.index($from.depth - 1) !== $from.node($from.depth - 1).childCount - 1) return false;
  const found = detailsParent(state)!;
  const tr = closeHistory(state.tr);
  if (found.node.lastChild!.childCount > 1) tr.delete($from.before(), $from.after());
  const after = tr.mapping.map(found.pos + found.node.nodeSize);
  tr.insert(after, state.schema.nodes.paragraph.create());
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
  return true;
};

export const detailsBackspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const found = detailsParent(state);
  if (!found) return false;
  if ($from.parent.type.name === 'details_summary') {
    const body = found.node.lastChild!;
    if (!found.node.firstChild!.content.size && body.childCount === 1 && body.firstChild!.type.name === 'paragraph' && !body.firstChild!.content.size) return unwrapDetails(found.pos)(state, dispatch);
    return true;
  }
  if ($from.node($from.depth - 1).type.name === 'details_body' && $from.index($from.depth - 1) === 0) {
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, found.pos + 2 + found.node.firstChild!.content.size)).scrollIntoView());
    return true;
  }
  return false;
};

export const detailsDeleteBoundary: Command = state => {
  const { $from, empty } = state.selection;
  return empty && $from.parent.type.name === 'details_summary' && $from.parentOffset === $from.parent.content.size;
};
