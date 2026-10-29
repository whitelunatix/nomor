import { afterEach, expect, it, vi } from 'vitest';
import { reconcileFixedWidths, TableLayoutController } from './dom';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function buildTable(rows: number, columns: number) {
  const root = document.body.appendChild(document.createElement('div'));
  const wrapper = root.appendChild(document.createElement('div'));
  const table = wrapper.appendChild(document.createElement('table'));
  const colgroup = table.appendChild(document.createElement('colgroup'));
  const tbody = table.appendChild(document.createElement('tbody'));
  for (let row = 0; row < rows; row += 1) {
    const tr = tbody.appendChild(document.createElement('tr'));
    for (let column = 0; column < columns; column += 1) {
      tr.appendChild(document.createElement('td'));
    }
  }
  return { root, wrapper, table, colgroup, tbody };
}

it('pads fixed column widths to the real column count when a column is inserted', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  const { root, wrapper, table, colgroup } = buildTable(2, 3);
  let columns = 3;
  const controller = new TableLayoutController(root);
  const registration = controller.register({
    table,
    wrapper,
    colgroup,
    columns: () => columns,
    cells: () => [],
    fixedWidths: () => [100, 200, 300],
  });
  await controller.flush();
  expect([...colgroup.children].map((col) => (col as HTMLElement).style.width)).toEqual([
    '100px',
    '200px',
    '300px',
  ]);

  // 编辑器中先插入列、指令后同步：固定布局不能让新列停在 0 宽，
  // 同时保持整张表宽度不变，避免新列被推到滚动区域外。
  columns = 4;
  registration.update();
  await controller.flush();
  expect([...colgroup.children].map((col) => (col as HTMLElement).style.width)).toEqual([
    '75px',
    '150px',
    '225px',
    '150px',
  ]);
  expect(table.style.width).toBe('600px');
  expect(table.dataset.tableLayout).toBe('fixed');
  controller.destroy();
});

it('truncates fixed column widths when a column is removed', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  const { root, wrapper, table, colgroup } = buildTable(1, 3);
  let columns = 3;
  const controller = new TableLayoutController(root);
  const registration = controller.register({
    table,
    wrapper,
    colgroup,
    columns: () => columns,
    cells: () => [],
    fixedWidths: () => [100, 200, 300],
  });
  await controller.flush();
  columns = 2;
  registration.update();
  await controller.flush();
  expect(colgroup.childElementCount).toBe(2);
  expect(table.style.width).toBe('300px');
  controller.destroy();
});

it('reconcileFixedWidths keeps widths untouched when the counts already agree', () => {
  const widths = [120, 240];
  const result = reconcileFixedWidths(widths, 2);
  expect(result).toEqual([120, 240]);
  expect(result).not.toBe(widths);
  expect(reconcileFixedWidths(widths, 0)).toEqual([120, 240]);
});
