import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { tryParseMarkdown } from '../../../lib/editor-core/markdown';
import { projectInlineSource, readTaskListMarker } from '../../../lib/editor-core/InlineSourceCodec';
import { extractDocumentTocItems } from '../../../lib/toc/tocService';
import { t } from '../../i18n';
import type { WordDocument, WordNode } from './protocol';

/** 每个顶层块独立投影并让出主线程，不建立常驻编辑器或保存位置映射。 */
export async function createWordModel(markdown: string, title: string, signal: AbortSignal,
  resolve: (node: WordNode) => Promise<string | null | undefined>, warnings: Set<string>): Promise<WordDocument> {
  signal.throwIfAborted();
  const doc = tryParseMarkdown(markdown, { exportImageSources: true });
  if (!doc) throw new Error(t.wordExportParseError());
  const headings = extractDocumentTocItems(doc).map(({ id, title, level }) => ({ id, title, level }));
  const nodes: WordNode[] = [];
  const footnotes = new Set<string>();
  const refs = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'footnote_def') footnotes.add(String(node.attrs.id));
    if (node.type.name === 'footnote_ref') refs.add(String(node.attrs.id));
    if (node.isText && node.marks.some((mark) => mark.type.name === 'inline_source' && mark.attrs.literal) && /^\s*</.test(node.text ?? '')) {
      warnings.add(t.wordExportHtmlWarning());
    }
  });
  for (const id of refs) if (!footnotes.has(id)) warnings.add(t.wordExportFootnoteWarning({ id }));
  let processed = 0;
  async function prepare(source: ProseMirrorNode, node: WordNode) {
    signal.throwIfAborted();
    if (++processed % 100 === 0) await new Promise<void>((done) => setTimeout(done, 0));
    if (['image', 'math_inline', 'math_block', 'mermaid_block'].includes(node.type)) {
      const id = await resolve(node);
      if (id) node.attrs = { ...node.attrs, wordMedia: id };
    }
    if (node.type === 'table' && source.type.name === 'table') {
      node.attrs = { ...node.attrs, wordColumns: TableMap.get(source).width };
    }
    for (let i = 0; i < (node.content?.length ?? 0); i++) {
      // 投影后行内 child 数量可能改变；只有 list_item 需要原树中的任务标记。
      await prepare(source.childCount > i ? source.child(i) : source, node.content![i]);
    }
    if (node.type === 'list_item' && source.type.name === 'list_item' && source.firstChild) {
      const task = readTaskListMarker(source.firstChild);
      if (task) {
        node.attrs = { ...node.attrs, wordTask: task.checked };
        const firstText = node.content?.[0]?.content?.[0];
        if (firstText?.text?.startsWith(task.text)) firstText.text = firstText.text.slice(task.text.length);
      }
    }
  }
  for (let i = 0; i < doc.childCount; i++) {
    signal.throwIfAborted();
    const source = doc.child(i);
    const projected = projectInlineSource(source).toJSON() as WordNode;
    await prepare(source, projected);
    nodes.push(projected);
    if (i % 20 === 0) await new Promise<void>((done) => setTimeout(done, 0));
  }
  return { title, nodes, headings, media: [], labels: { comment: t.comment() } };
}
