import { distributeWidth, minimumWidth, type ColumnWidth } from '../shared/table-column-widths'

export interface PdfTable {
  table: HTMLElement
  rows: HTMLElement[][]
  columns: ColumnWidth[]
}

const TABLE_SELECTOR = '.cm-md-table-widget'
const MAX_SAMPLE_ROWS = 24
const MAX_CELLS_TO_REFINE = 240

function measureColumns(table: HTMLElement, [headers, ...body]: HTMLElement[][]): ColumnWidth[] {
  const stride = Math.max(1, Math.ceil(body.length / MAX_SAMPLE_ROWS))
  const rows = body.filter((_, index) => index % stride === 0)
  const measure = document.createRange()
  const textWidth = (cell: HTMLElement) => {
    measure.selectNodeContents(cell)
    return measure.getBoundingClientRect().width
  }

  table.classList.add('cm-md-table-measuring')
  try {
    return headers.map((header, index) => {
      const style = getComputedStyle(header)
      const em = parseFloat(style.fontSize)
      const padding = parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd) + 2
      const heading = textWidth(header)
      const bodyWidths = rows.map((row) => textWidth(row[index])).sort((a, b) => a - b)
      const typical = bodyWidths[Math.floor((bodyWidths.length - 1) * 0.75)] ?? 0
      const headingTarget = heading <= 6 * em ? heading : heading / 2
      // Reserve room for short labels and values. Exceptionally long text can
      // wrap, even when it fills a whole column in the source.
      const minimum = padding + Math.max(Math.min(headingTarget, 5 * em), Math.min(typical, 4 * em))
      return { minimum, preferred: padding + Math.max(headingTarget, typical) }
    })
  } finally {
    table.classList.remove('cm-md-table-measuring')
  }
}

export function measurePdfTables(root: HTMLElement): PdfTable[] {
  const tables: PdfTable[] = []
  for (const table of root.querySelectorAll<HTMLElement>(TABLE_SELECTOR)) {
    const rows = Array.from(table.querySelectorAll<HTMLElement>(':scope > .cm-md-table-row'), (row) =>
      Array.from(row.querySelectorAll<HTMLElement>(':scope > .cm-md-table-cell')))
    const headers = rows[0]
    if (!headers || headers.length < 2 || table.querySelector('img:not(.cm-widgetBuffer), svg, .cm-md-math, [colspan], [rowspan]')) continue
    if (rows.some((row) => row.length !== headers.length)) continue
    tables.push({ table, rows, columns: measureColumns(table, rows) })
  }
  return tables
}

export function needsLandscape(tables: PdfTable[]): boolean {
  return tables.some(({ table, columns }) => minimumWidth(columns) > table.clientWidth)
}

export function fitPdfTable({ table, rows, columns }: PdfTable): void {
  const available = table.clientWidth
  if (available <= 0) return

  table.style.tableLayout = 'fixed'
  const apply = (widths: number[]) => {
    const percentages = widths.map((width) => `${(width / available) * 100}%`)
    for (const row of rows) {
      row.forEach((cell, index) => cell.style.setProperty('width', percentages[index], 'important'))
    }
  }
  const widths = distributeWidth(columns, available)
  apply(widths)
  if (rows.length * columns.length > MAX_CELLS_TO_REFINE) return

  // Try a small transfer from a column with room to spare. Use the browser's
  // wrapped row heights, including the header, to keep only a real improvement.
  const score = () => rows.reduce((sum, row) => sum + (row[0].parentElement?.getBoundingClientRect().height ?? 0), 0)
  let bestScore = score()
  let best = widths
  const step = available * 0.035
  for (const [target, width] of widths.entries()) {
    if (columns[target].preferred <= width) continue
    let donor = -1
    let slack = step
    for (const [index, other] of widths.entries()) {
      if (index === target) continue
      const { preferred, minimum } = columns[index]
      const floor = other >= preferred ? preferred : minimum
      if (other - floor > slack) {
        donor = index
        slack = other - floor
      }
    }
    if (donor === -1) continue
    const trial = [...widths]
    trial[target] += step
    trial[donor] -= step
    apply(trial)
    const height = score()
    if (height + 1 < bestScore) {
      best = trial
      bestScore = height
    }
  }
  apply(best)
}
