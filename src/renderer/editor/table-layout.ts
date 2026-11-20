// Measure small tables in their actual font and available width. Large tables
// and cells with independently sized media use the browser's automatic layout.
const MAX_MEASURED_CELLS = 240
const MAX_COLUMN_GROWTH = 0.1
export const TABLE_COLUMN_MIN_WIDTH = '--cm-md-column-min-width'
const MEASURING = 'cm-md-table-measuring'

const cleanups = new WeakMap<HTMLElement, () => void>()

function rebalance(table: HTMLTableElement, headers: HTMLTableCellElement[], availableWidth: number): void {
  for (const header of headers) header.style.removeProperty(TABLE_COLUMN_MIN_WIDTH)
  if (table.offsetWidth > availableWidth + 1) return

  const widths = headers.map((header) => header.getBoundingClientRect().width)
  const cells = Array.from(table.rows).flatMap((row) => Array.from(row.cells, (cell) => {
    const range = document.createRange()
    range.selectNodeContents(cell)
    if (cell.lastElementChild?.classList.contains('cm-md-table-cell-input')) {
      range.setEndBefore(cell.lastElementChild)
    }
    const style = getComputedStyle(cell)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
    const inset = parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd)
    return { range, column: cell.cellIndex, lineHeight, inset }
  }))
  const lineCount = ({ range, lineHeight }: typeof cells[number]) =>
    Math.max(1, Math.round(range.getBoundingClientRect().height / lineHeight))
  const countLines = () => cells.reduce((sum, cell) => sum + lineCount(cell), 0)
  let best = 0
  const wrapped = cells.filter((cell) => {
    const lines = lineCount(cell)
    best += lines
    return lines > 1
  })
  if (!wrapped.length) return

  const candidates = [...widths]
  // One candidate per column: enough room for the nearby single-line widths.
  // Give the browser one layout pass to measure them with wrapping suspended.
  table.classList.add(MEASURING)
  try {
    for (const { range, column, inset } of wrapped) {
      const needed = Math.ceil(range.getBoundingClientRect().width + inset + 2)
      if (needed <= widths[column] + availableWidth * MAX_COLUMN_GROWTH) {
        candidates[column] = Math.max(candidates[column], needed)
      }
    }
  } finally {
    table.classList.remove(MEASURING)
  }

  const trials = candidates.map((width, column) => ({ column, width, growth: width - widths[column] }))
    .filter(({ growth }) => growth > 1)
    .sort((a, b) => a.growth - b.growth)
  for (const { column, width } of trials) {
    const header = headers[column]
    header.style.setProperty(TABLE_COLUMN_MIN_WIDTH, `${width}px`)
    const score = countLines()
    if (score < best && table.scrollWidth <= availableWidth + 1 && table.offsetWidth <= availableWidth + 1) {
      best = score
    } else {
      header.style.removeProperty(TABLE_COLUMN_MIN_WIDTH)
    }
  }
}

export function observeTableLayout(table: HTMLTableElement, onHeightChange: () => void): void {
  const headers = Array.from(table.tHead?.rows[0]?.cells ?? [])
  if (headers.length < 2 || headers.length * table.rows.length > MAX_MEASURED_CELLS) return
  if (table.querySelector('img, .cm-md-math')) return

  let container: HTMLElement | null = null
  let previous = ''
  let frame = 0
  const observer = new ResizeObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const parent = table.parentElement
      if (!table.isConnected || !parent) return
      if (parent !== container) {
        if (container) observer.unobserve(container)
        observer.observe(parent)
        container = parent
      }
      const width = parent.clientWidth
      if (!width) return
      const geometry = () => `${width}:${table.offsetWidth}:${table.offsetHeight}:${getComputedStyle(table).font}`
      if (geometry() === previous) return
      const oldHeight = table.offsetHeight
      rebalance(table, headers, width)
      previous = geometry()
      if (table.offsetHeight !== oldHeight) onHeightChange()
    })
  })
  observer.observe(table)
  cleanups.set(table, () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
  })
}

export function stopObservingTableLayout(dom: HTMLElement): void {
  cleanups.get(dom)?.()
  cleanups.delete(dom)
}
