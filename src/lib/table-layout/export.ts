import { TableLayoutController, semanticCellContent, type TableCellSource } from './dom';

/** Logical grid for semantic HTML; rowspans consume positions, not additional cells. */
export function domTableGrid(table: HTMLTableElement) {
  const occupied: number[] = [];
  const cells: TableCellSource[] = [];
  let columns = 0;
  Array.from(table.rows).forEach((row, rowIndex) => {
    let column = 0;
    for (const element of Array.from(row.cells)) {
      while ((occupied[column] ?? 0) > rowIndex) column++;
      const span = Math.max(1, element.colSpan);
      const raw = element.getAttribute('data-colwidth');
      cells.push({
        key: element,
        element,
        column,
        span,
        header: element.tagName === 'TH',
        explicit: raw?.split(',').map(Number),
        content: () => semanticCellContent(element),
      });
      for (let i = 0; i < span; i++)
        occupied[column + i] =
          element.rowSpan === 0 ? table.rows.length : rowIndex + Math.max(1, element.rowSpan);
      column += span;
      columns = Math.max(columns, column);
    }
  });
  return { columns, cells };
}

export function createExportTableLayout(root: HTMLElement) {
  const tables = root.querySelectorAll<HTMLTableElement>('table');
  if (!tables.length) return { flush: async (_printing = false) => {}, destroy() {} };
  const controller = new TableLayoutController(root);
  for (const table of tables) {
    let wrapper = table.parentElement!;
    if (!wrapper.classList.contains('nomo-table-scroll')) {
      wrapper = table.ownerDocument.createElement('div');
      wrapper.className = 'nomo-table-scroll';
      table.before(wrapper);
      wrapper.append(table);
    }
    table
      .querySelectorAll(':scope > colgroup[data-table-layout-owned]')
      .forEach((node) => node.remove());
    const colgroup = table.ownerDocument.createElement('colgroup');
    colgroup.dataset.tableLayoutOwned = 'true';
    table.prepend(colgroup);
    const grid = domTableGrid(table);
    controller.register({
      table,
      wrapper,
      colgroup,
      columns: () => grid.columns,
      cells: () => grid.cells,
    });
  }
  return controller;
}
