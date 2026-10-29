import { DOMSerializer, type Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';
import { projectInlineSource } from '../InlineSourceCodec';
import { TableLayoutController, type TableCellSource } from '../../table-layout/dom';
import { resolveTableColumnWidths } from '../../docxmd/presentation';
import { columnWidthsToPx } from '../../docxmd/tableWidths';
import { subscribeTypographyInteraction } from '../../typography/interaction';
import { renderKatexCached } from '../../services/katexMathRenderer';

const controllers = new WeakMap<EditorView, TableLayoutController>();
function controllerFor(view: EditorView) {
  let controller = controllers.get(view);
  if (!controller) {
    controller = new TableLayoutController(view.dom);
    controllers.set(view, controller);
  }
  return controller;
}
function releaseController(view: EditorView) {
  // Replacing EditorState can recreate plugin views while retaining table NodeViews.
  // Dispose after that synchronous transition, only when no live tables remain.
  queueMicrotask(() => {
    const controller = controllers.get(view);
    if (controller && (view.isDestroyed || controller.empty)) {
      controller.destroy();
      controllers.delete(view);
    }
  });
}

/** The plugin owns resources; suspended views destroy it along with their NodeViews. */
export function tableLayoutPlugin() {
  return new Plugin({
    view(view) {
      let revision = -1;
      const interaction = subscribeTypographyInteraction((snapshot) => {
        if (snapshot.geometryRevision === revision) return;
        revision = snapshot.geometryRevision;
        if (snapshot.geometrySource === 'font') controllers.get(view)?.invalidate();
      });
      return {
        destroy() {
          interaction.destroy();
          releaseController(view);
        },
      };
    },
  });
}

export const flushEditorTableLayout = (view: EditorView) =>
  controllers.get(view)?.flush() ?? Promise.resolve();

/** Owns only the scroll shell and colgroup, never the editable tbody. */
export class TableNodeView {
  readonly dom: HTMLDivElement;
  readonly table: HTMLTableElement;
  readonly contentDOM: HTMLTableSectionElement;
  private readonly colgroup: HTMLTableColElement;
  private readonly registration: ReturnType<TableLayoutController['register']>;

  constructor(
    private node: ProseMirrorNode,
    private view: EditorView,
  ) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'nomo-table-scroll';
    this.table = this.dom.appendChild(doc.createElement('table'));
    this.colgroup = this.table.appendChild(doc.createElement('colgroup'));
    this.colgroup.dataset.tableLayoutOwned = 'true';
    this.contentDOM = this.table.appendChild(doc.createElement('tbody'));
    this.registration = controllerFor(view).register({
      table: this.table,
      wrapper: this.dom,
      colgroup: this.colgroup,
      columns: () => TableMap.get(this.node).width,
      cells: () => this.cells(),
      // `.docx.md` 的显式列宽优先于自动测量；普通 Markdown 返回 null。
      // 必须经文档级定义展开 `use` / `var`，否则变量表格会退回等宽自动布局。
      fixedWidths: () =>
        columnWidthsToPx(resolveTableColumnWidths(this.view.state.doc, this.node)),
    });
  }

  private *cells(): Generator<TableCellSource> {
    const node = this.node;
    const map = TableMap.get(node);
    const logicalColumns = new Map<number, number>();
    map.map.forEach((offset, index) => {
      if (!logicalColumns.has(offset)) logicalColumns.set(offset, index % map.width);
    });
    const nodes = DOMSerializer.nodesFromSchema(node.type.schema);
    nodes.math_inline = (math) => {
      const element = this.dom.ownerDocument.createElement('span');
      element.className = 'math-inline';
      element.dataset.tex = String(math.attrs.tex ?? '');
      element.innerHTML = renderKatexCached(element.dataset.tex, {
        displayMode: false,
        throwOnError: false,
        trust: false,
      });
      return element;
    };
    const serializer = new DOMSerializer(nodes, DOMSerializer.marksFromSchema(node.type.schema));
    let rowOffset = 0;
    for (let row = 0; row < node.childCount; row++) {
      const rowNode = node.child(row);
      let offset = rowOffset + 1;
      for (let column = 0; column < rowNode.childCount; column++) {
        const cell = rowNode.child(column);
        const element = this.contentDOM.rows[row]?.cells[column];
        if (!element) throw new Error('Table DOM is not ready for measurement');
        yield {
          key: cell,
          element,
          column: logicalColumns.get(offset)!,
          span: cell.attrs.colspan,
          header: cell.type.spec.tableRole === 'header_cell',
          explicit: cell.attrs.colwidth,
          content: () => {
            const fragment = element.ownerDocument.createDocumentFragment();
            serializer.serializeFragment(
              projectInlineSource(cell).content,
              { document: element.ownerDocument },
              fragment,
            );
            return fragment;
          },
        };
        offset += cell.nodeSize;
      }
      rowOffset += rowNode.nodeSize;
    }
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    if (node !== this.node) {
      this.node = node;
      this.registration.update();
    }
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === 'selection') return false;
    if (mutation.target === this.colgroup || this.colgroup.contains(mutation.target)) return true;
    if (
      mutation.type === 'attributes' &&
      (mutation.target === this.dom || mutation.target === this.table)
    ) {
      return (
        mutation.attributeName === 'style' ||
        mutation.attributeName?.startsWith('data-table-layout') === true ||
        mutation.attributeName?.startsWith('data-docx-') === true
      );
    }
    return (
      mutation.type === 'childList' &&
      mutation.target === this.table &&
      [...mutation.addedNodes, ...mutation.removedNodes].every((node) => node === this.colgroup)
    );
  }

  destroy() {
    this.registration.destroy();
    releaseController(this.view);
  }
}
