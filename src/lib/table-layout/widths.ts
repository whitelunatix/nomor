/** CSS-pixel policy shared by editable tables and the offline export runtime. */
export const TABLE_WIDTH_POLICY = {
  emptyEm: 3,
  minimumEm: 6,
  headerEm: 12,
  bodyEm: 28,
  longValueEm: 12,
  debounceMs: 150,
  batchMs: 4,
  cacheEntries: 2048,
  cacheBytes: 2 * 1024 * 1024,
} as const;

export interface CellMetrics {
  column: number;
  span: number;
  header: boolean;
  natural: number;
  atomic: number;
  chrome: number;
  explicit?: readonly number[] | null;
}
export interface ColumnConstraint {
  minimum: number;
  preferred: number;
}
export interface TableWidths {
  columns: number[];
  width: number;
  overflow: boolean;
}

/** Input contains each physical cell once, including cells spanning multiple rows. */
export function tableConstraints(
  count: number,
  cells: readonly CellMetrics[],
  em: number,
): ColumnConstraint[] {
  const policy = TABLE_WIDTH_POLICY;
  const groups: CellMetrics[][] = Array.from({ length: count }, () => []);
  for (const cell of cells)
    if (cell.span === 1 && groups[cell.column]) groups[cell.column].push(cell);
  const maximum = (values: readonly CellMetrics[], field: 'chrome' | 'natural' | 'atomic') =>
    values.reduce((max, cell) => Math.max(max, cell[field]), 0);
  const columns = Array.from({ length: count }, (_, column) => {
    const own = groups[column];
    const chrome = maximum(own, 'chrome');
    const natural = maximum(own, 'natural');
    const header = maximum(
      own.filter((cell) => cell.header),
      'natural',
    );
    const body = own
      .filter((cell) => !cell.header && cell.natural > 0)
      .map((cell) => cell.natural)
      .sort((a, b) => a - b);
    const p90 = body.length ? body[Math.ceil(body.length * 0.9) - 1] : 0;
    const longest = body.at(-1) ?? 0;
    const minimum =
      chrome +
      Math.max(
        policy.emptyEm * em,
        Math.min(natural, policy.minimumEm * em),
        // Keep ordinary headers readable when body columns compete for space.
        Math.min(header, policy.headerEm * em),
        maximum(own, 'atomic'),
      );
    return {
      minimum,
      preferred: Math.max(
        minimum,
        chrome +
          Math.max(
            Math.min(header, policy.headerEm * em),
            Math.min(p90, policy.bodyEm * em),
            Math.min(longest, policy.longValueEm * em),
          ),
      ),
    };
  });
  // Existing authored widths are constraints, never a destination for auto widths.
  for (const cell of cells)
    cell.explicit?.forEach((width, offset) => {
      const column = columns[cell.column + offset];
      if (!column || !Number.isFinite(width) || width <= 0) return;
      column.minimum = Math.max(column.minimum, width);
      column.preferred = Math.max(column.preferred, column.minimum);
    });
  const raise = (start: number, span: number, field: keyof ColumnConstraint, required: number) => {
    const group = columns.slice(start, start + span);
    const total = group.reduce((sum, column) => sum + column[field], 0);
    if (!group.length || total >= required) return;
    const weights = group.map((column) => column.preferred);
    const sum = weights.reduce((a, b) => a + b, 0);
    group.forEach((column, index) => {
      column[field] += (required - total) * (sum ? weights[index] / sum : 1 / group.length);
      column.preferred = Math.max(column.preferred, column.minimum);
    });
  };
  for (const cell of cells.filter((cell) => cell.span > 1).sort((a, b) => a.span - b.span)) {
    const minimum =
      cell.chrome +
      Math.max(
        policy.emptyEm * em * cell.span,
        Math.min(
          cell.natural,
          (cell.header ? policy.headerEm : policy.minimumEm) * em * cell.span,
        ),
        cell.atomic,
      );
    raise(cell.column, cell.span, 'minimum', minimum);
    raise(
      cell.column,
      cell.span,
      'preferred',
      Math.max(
        minimum,
        cell.chrome +
          Math.min(cell.natural, (cell.header ? policy.headerEm : policy.bodyEm) * em * cell.span),
      ),
    );
  }
  return columns;
}

export function allocateTableWidths(
  constraints: readonly ColumnConstraint[],
  available: number,
): TableWidths {
  const minimum = constraints.reduce((sum, column) => sum + column.minimum, 0);
  const preferred = constraints.reduce((sum, column) => sum + column.preferred, 0);
  const target = Math.max(minimum, Math.min(Math.max(0, available), preferred));
  const ratio = preferred > minimum ? (target - minimum) / (preferred - minimum) : 0;
  // Hundredths keep span minima intact to subpixel tolerance without a drifting last column.
  let previous = 0;
  let cumulative = 0;
  const columns = constraints.map((column) => {
    cumulative += column.minimum + ratio * (column.preferred - column.minimum);
    const rounded = Math.round(cumulative * 100) / 100;
    const width = rounded - previous;
    previous = rounded;
    return Math.round(width * 100) / 100;
  });
  return { columns, width: Math.round(target * 100) / 100, overflow: minimum > available };
}
