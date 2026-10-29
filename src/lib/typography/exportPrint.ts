const PX_PER_MM = 96 / 25.4;

/** 仅提升不会被 rowspan 穿越的连续前置表头；不改变单元格及列宽语义。 */
export function promotePrintTableHeaders(table: HTMLTableElement): void {
  if (table.tHead) return;
  const rows = [...table.rows];
  let count = 0;
  while (count < rows.length && rows[count].cells.length && [...rows[count].cells].every(cell => cell.tagName === 'TH')) count++;
  if (!count || count === rows.length) return;
  if (rows.slice(0, count).some((row, index) => [...row.cells].some(cell => cell.rowSpan === 0 || index + cell.rowSpan > count))) return;
  const header = table.createTHead();
  rows.slice(0, count).forEach(row => header.append(row));
}

export function preparePrintDocument(root: HTMLElement, widthMm: number, heightMm = 257): void {
  if (![widthMm, heightMm].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid print dimensions');
  // 必须在字体、媒体、KP 和分页测量之前展开；只操作独立打印文档。
  root.querySelectorAll<HTMLDetailsElement>('details').forEach(details => { details.open = true; });
  root.classList.add('nomo-print');
  root.ownerDocument.body.classList.add('nomo-print-document');
  root.style.setProperty('width', `${widthMm}mm`, 'important');
  root.style.setProperty('max-width', 'none', 'important');
  root.style.setProperty('padding', '0', 'important');
  root.style.setProperty('margin', '0', 'important');
  root.style.setProperty('--nomo-print-height', `${heightMm}mm`);
  root.querySelectorAll<HTMLTableElement>('table').forEach(promotePrintTableHeaders);
  // 留出所在块的边距和内边距，超高媒体仍能完整放进一张可打印页面。
  const maximum = Math.max(1, heightMm * PX_PER_MM - 80);
  root.querySelectorAll<HTMLElement>('img,.mermaid-block-rendered svg').forEach(media => {
    media.style.setProperty('max-height', `${maximum}px`);
    media.style.setProperty('max-width', '100%');
    media.style.setProperty('object-fit', 'contain');
  });
}

/** 在字体、媒体和目标宽度布局完成后区分短块与需要跨页的长块。 */
export function classifyPrintBlocks(root: HTMLElement, heightMm: number): void {
  const limit = heightMm * PX_PER_MM;
  root.querySelectorAll<HTMLElement>('.code-card,.mermaid-block,.math-block,.nomo-table-scroll').forEach(block => {
    const style = getComputedStyle(block);
    const height = block.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    block.classList.toggle('nomo-print-split', height > limit);
    block.classList.toggle('nomo-print-keep', height <= limit);
  });
}
