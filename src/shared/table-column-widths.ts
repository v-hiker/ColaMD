export interface ColumnWidth {
  minimum: number
  preferred: number
}

export function minimumWidth(columns: ColumnWidth[]): number {
  return columns.reduce((total, column) => total + column.minimum, 0)
}

/** Allocate width to columns with longer content after short columns fit. */
export function distributeWidth(columns: ColumnWidth[], available: number): number[] {
  const minimum = minimumWidth(columns)
  if (minimum >= available) return columns.map((column) => available * column.minimum / minimum)

  const widths = columns.map((column) => column.minimum)
  const needs = columns.map((column, index) => ({ index, width: column.preferred - column.minimum }))
    .sort((a, b) => a.width - b.width)
  let remaining = available - minimum
  for (const [index, need] of needs.entries()) {
    const extra = Math.min(need.width, remaining / (needs.length - index))
    widths[need.index] += extra
    remaining -= extra
  }
  // Once every column's typical content fits, spread the extra paper width
  // in proportion to the widths already assigned.
  const used = available - remaining
  return widths.map((width) => width * available / used)
}
