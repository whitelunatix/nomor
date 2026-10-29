import { describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { TableMap } from 'prosemirror-tables';
import { createEditorCore } from '../editor-core/createEditorCore';
import { parseMarkdown } from '../editor-core/markdown';
import { docxFieldSchema } from './fieldSchema';
import { applyDocxEdits } from './directivePatch';
import { validateDocxMarkdown } from './validate';
import {
  buildDocxContext,
  contextDirectives,
  docxTargetId,
  parseDocxTargetId,
} from './inspector';

const TABLE = [
  '<!-- @table.header | bg: #D9E2F3; border.visible: bottom; border.thickness: 0.75pt & font | style: bold -->',
  '<!-- table | border.visible: top bottom; col.width: 4.2cm 2.4cm -->',
  '| 列A | 列B |',
  '|:---:|:---:|',
  '| 一 | 二 |',
].join('\n');

function contextAt(doc: ReturnType<typeof parseMarkdown>, pos: number) {
  return buildDocxContext(doc, doc.resolve(pos), true, {
    revision: 7,
    directivesVisible: false,
  });
}

describe('docx directive patch', () => {
  it('replaces only the target value span, keeping aliases and spacing', () => {
    const line =
      '<!-- @table.header | bg: #D9E2F3; border.visible: bottom; border.thickness: 0.75pt & font | style: bold -->';
    const next = applyDocxEdits([line], [
      { type: 'setField', lineIndex: 0, groupIndex: 0, fieldIndex: 0, value: '#FFFFFF' },
    ]);
    expect(next).toEqual([
      '<!-- @table.header | bg: #FFFFFF; border.visible: bottom; border.thickness: 0.75pt & font | style: bold -->',
    ]);
  });

  it('adds quoted fields and removes the adjacent separator', () => {
    const line = '<!-- table | border.visible: top bottom; align: center -->';
    const added = applyDocxEdits([line], [
      { type: 'addField', lineIndex: 0, groupIndex: 0, name: 'col.width', value: '4.2cm 2.4cm' },
    ]);
    expect(added?.[0]).toBe(
      '<!-- table | border.visible: top bottom; align: center; col.width: 4.2cm 2.4cm -->',
    );

    const removed = applyDocxEdits([line], [
      { type: 'removeField', lineIndex: 0, groupIndex: 0, fieldIndex: 1 },
    ]);
    expect(removed?.[0]).toBe('<!-- table | border.visible: top bottom -->');
  });

  it('moves a valueless switch field to an explicit value', () => {
    const line = '<!-- font | bold; italic -->';
    const next = applyDocxEdits([line], [
      { type: 'setField', lineIndex: 0, groupIndex: 0, fieldIndex: 0, value: 'false' },
    ]);
    expect(next?.[0]).toBe('<!-- font | bold: false; italic -->');
  });

  it('rejects stale indexes, malformed replacements and invalid new lines', () => {
    const line = '<!-- font | bold -->';
    expect(
      applyDocxEdits([line], [
        { type: 'setField', lineIndex: 0, groupIndex: 0, fieldIndex: 3, value: 'x' },
      ]),
    ).toBeNull();
    expect(
      applyDocxEdits([line], [
        { type: 'replaceDirective', lineIndex: 0, raw: '<!-- font | bold' },
      ]),
    ).toBeNull();
    expect(
      applyDocxEdits([line], [
        { type: 'addDirective', lineIndex: 0, raw: 'not a directive' },
      ]),
    ).toBeNull();
    expect(
      applyDocxEdits([line], [
        { type: 'setField', lineIndex: 2, groupIndex: 0, fieldIndex: 0, value: 'x' },
      ]),
    ).toBeNull();
  });

  it('removes a directive and inserts a new one at the requested line', () => {
    const lines = ['<!-- font | bold -->', '<!-- page | size: A4 -->'];
    const next = applyDocxEdits(lines, [
      { type: 'removeDirective', lineIndex: 0 },
      { type: 'addDirective', lineIndex: 2, raw: '<!-- section | start: nextPage -->' },
    ]);
    expect(next).toEqual([
      '<!-- page | size: A4 -->',
      '<!-- section | start: nextPage -->',
    ]);
  });
});

describe('docx inspector', () => {
  it('round-trips opaque target ids', () => {
    const cell = docxTargetId(3, 'block', { row: 1, column: 2 });
    expect(cell).toBe('b:3/c:1:2');
    expect(parseDocxTargetId(cell)).toEqual({
      blockIndex: 3,
      kind: 'block',
      cell: { row: 1, column: 2 },
    });
    expect(parseDocxTargetId('m:0')).toEqual({
      blockIndex: 0,
      kind: 'meta',
      cell: null,
    });
    expect(parseDocxTargetId('x:1')).toBeNull();
  });

  it('exposes the block prefix and inherited style for a paragraph', () => {
    const markdown = [
      '<!-- global.paragraph | align: justify; line.spacing: 1.5 -->',
      '<!-- font | zh: 宋体 小四 -->',
      '正文段落',
    ].join('\n');
    const doc = parseMarkdown(markdown, { docx: true });
    const context = contextAt(doc, doc.child(0).nodeSize + 2);
    expect(context.kind).toBe('paragraph');
    expect(context.targetId).toBe('b:1');
    expect(context.directives).toHaveLength(1);
    expect(context.directives[0]!.groups[0]!.fields[0]!.rawName).toBe('zh');
    expect(context.effective?.style['font-size']).toBe('12pt');
    expect(context.effective?.style['line-height']).toBe('1.5');
    // 文档级默认值与块内指令分开展示。
    expect(context.globals.paragraph['text-align']).toBe('justify');
    expect(context.document[0]?.badge).toBe('文档全局');
  });

  it('reports an invalid directive line without dropping it', () => {
    const [invalid] = contextDirectives(['<!-- font | bold', '<!-- font | bold -->']);
    expect(invalid?.valid).toBe(false);
    expect(invalid?.raw).toBe('<!-- font | bold');
    expect(invalid?.diagnostics[0]?.code).toBe('DOCX_PARSE');
  });

  it('resolves a table cell target with sheet coordinates and table directives', () => {
    const doc = parseMarkdown(TABLE, { docx: true });
    const table = doc.child(0);
    const map = TableMap.get(table);
    // TableMap 偏移相对表格内容；文档位置 = 表格位置(0) + 1 + offset。
    const secondHeaderCell = 1 + map.map[1]!;
    const context = contextAt(doc, secondHeaderCell + 1);
    expect(context.kind).toBe('tableCell');
    expect(context.targetId).toBe('b:0/c:0:1');
    expect(context.table).toMatchObject({ row: 0, column: 1, rows: 2, columns: 2 });
    expect(context.directives.map((entry) => entry.canonicalKeyword)).toEqual([
      '@table.header',
      'table',
    ]);
    expect(context.effective?.table?.borderVisible).toEqual(['top', 'bottom']);
    expect(context.effective?.table?.colWidths).toEqual(['4.2cm', '2.4cm']);
  });

  it('gives meta directives a document entry and a selectable target id', () => {
    const markdown = ['<!-- section | start: nextPage -->', '正文'].join('\n');
    const doc = parseMarkdown(markdown, { docx: true });
    const context = contextAt(doc, 0);
    expect(context.kind).toBe('meta');
    expect(context.targetId).toBe('m:0');
    expect(context.meta).toEqual({ kind: 'section', sectionIndex: 1 });
    expect(context.document[0]).toMatchObject({
      targetId: 'm:0',
      badge: '分节',
      sectionIndex: 1,
    });
    expect(context.document[0]?.summary).toContain('第 1 节');
  });
});

describe('docx field schema', () => {
  it('selects enum controls per directive keyword', () => {
    expect(docxFieldSchema('caption', 'type').options?.map((item) => item.value)).toEqual([
      'figure',
      'table',
    ]);
    expect(docxFieldSchema('break', 'type').options?.map((item) => item.value)).toContain('page');
    expect(docxFieldSchema('@table.cell', 'position').control).toBe('position');
    expect(docxFieldSchema('header', 'position').control).toBe('enum');
    expect(docxFieldSchema('@list.numbering', 'format').options?.map((item) => item.value)).toContain(
      'upperRoman',
    );
    expect(docxFieldSchema('font', 'bg').control).toBe('color');
    expect(docxFieldSchema('font', 'size').control).toBe('length');
  });
});

describe('docx editor commands', () => {
  it('applies a panel edit through history and rejects a stale revision', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({
      markdown: ['<!-- font | zh: 宋体 小四 -->', '正文'].join('\n'),
      docxMode: true,
      target,
    });
    editor.focus();
    const before = editor.getDocxContext();
    expect(before?.targetId).toBe('b:0');
    const field = before!.directives[0]!.groups[0]!.fields[0]!;
    expect(field.rawName).toBe('zh');

    expect(
      editor.execute({
        type: 'applyDocxEdits',
        revision: before!.revision,
        targetId: before!.targetId!,
        edits: [
          {
            type: 'setField',
            lineIndex: 0,
            groupIndex: field.groupIndex,
            fieldIndex: field.fieldIndex,
            value: '楷体 五号',
          },
        ],
      }),
    ).toBe(true);
    expect(editor.flushMarkdown()).toContain('zh: 楷体 五号');
    expect(editor.getDocxContext()?.revision).toBe(before!.revision + 1);

    // 旧快照不能覆盖新正文。
    expect(
      editor.execute({
        type: 'applyDocxEdits',
        revision: before!.revision,
        targetId: before!.targetId!,
        edits: [
          {
            type: 'setField',
            lineIndex: 0,
            groupIndex: field.groupIndex,
            fieldIndex: field.fieldIndex,
            value: '黑体',
          },
        ],
      }),
    ).toBe(false);

    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(editor.flushMarkdown()).toContain('zh: 宋体 小四');
    editor.destroy();
  });

  it('locks the inspector to a structural meta without moving the selection', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({
      markdown: ['<!-- section | start: nextPage -->', '', '正文'].join('\n'),
      docxMode: true,
      target,
    });
    const view = (editor as unknown as { view: EditorView }).view;
    const selectionBefore = view.state.selection.from;
    expect(editor.getDocxContext()?.kind).toBe('paragraph');

    expect(editor.setDocxInspectTarget('m:0')).toBe(true);
    const locked = editor.getDocxContext()!;
    expect(locked.kind).toBe('meta');
    expect(locked.targetId).toBe('m:0');
    expect(locked.directives.map((item) => item.keyword)).toContain('section');
    expect(view.state.selection.from).toBe(selectionBefore);

    // 回到正文选区后恢复跟随光标。
    const paragraph = view.state.doc.child(1);
    let paragraphPos = view.state.doc.child(0).nodeSize;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, paragraphPos + 1, paragraphPos + 1 + paragraph.textContent.length),
      ),
    );
    expect(editor.getDocxContext()?.targetId).toBe('b:1');
    editor.destroy();
  });

  it('activates a structural marker on click without a text selection', () => {
    const target = document.createElement('div');
    const onDocxMetaActivate = vi.fn();
    const editor = createEditorCore({
      markdown: ['<!-- page | size: A4 -->', '', '正文'].join('\n'),
      docxMode: true,
      target,
      onDocxMetaActivate,
    });
    const view = (editor as unknown as { view: EditorView }).view;
    const selectionBefore = view.state.selection.from;
    const marker = target.querySelector<HTMLElement>('.docx-meta[data-docx-activatable="true"]');
    expect(marker).not.toBeNull();
    marker!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(onDocxMetaActivate).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'm:0', blockIndex: 0, kind: 'page' }),
    );
    expect(view.state.selection.from).toBe(selectionBefore);

    editor.setDocxInspectTarget('m:0');
    expect(editor.getDocxContext()?.kind).toBe('meta');
    editor.destroy();
  });

  it('toggles the debug directive overlay', () => {
    const target = document.createElement('div');
    const editor = createEditorCore({
      markdown: ['<!-- font | bold -->', '正文'].join('\n'),
      docxMode: true,
      target,
    });
    expect(target.classList.contains('docx-directives-visible')).toBe(false);
    expect(editor.execute({ type: 'setDocxDirectivesVisible', visible: true })).toBe(true);
    expect(target.classList.contains('docx-directives-visible')).toBe(true);
    expect(editor.getDocxContext()?.directivesVisible).toBe(true);
    editor.destroy();
  });

  it('jumps from a diagnostic line to its containing block', () => {
    const target = document.createElement('div');
    const markdown = [
      '<!-- font | wat: 1 -->',
      '',
      '正文段落',
    ].join('\n');
    const diagnostic = validateDocxMarkdown(markdown).diagnostics[0]!;
    expect(diagnostic.sourceLine).toBe(1);

    const editor = createEditorCore({ markdown, docxMode: true, target });
    const view = (editor as unknown as { view: EditorView }).view;
    expect(editor.revealMarkdownLine(diagnostic.sourceLine!)).toBe(true);
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe('正文段落');

    expect(editor.revealMarkdownLine(3)).toBe(true);
    expect(view.state.doc.resolve(view.state.selection.from).parent.textContent).toBe('正文段落');
    editor.destroy();
  });
});
