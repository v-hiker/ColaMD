import type { SyntaxNode } from '@lezer/common'

export interface CellSource {
  from: number
  to: number
  text: string
  syntax?: SyntaxNode
}

interface RowSource {
  cells: CellSource[]
  from: number
  to: number
  leadingPipe: boolean
  trailingPipe: boolean
}

const tableRows = new WeakMap<HTMLTableElement, RowSource[]>()
const BLOCK_PREFIX = /^(?:#{1,6}(?:[ \t]|$)|[><]|\x60{3,}|~{3,}|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)|\[[^\]]+\]:)/

/** Keep the offsets of the cell content, excluding its original padding. */
export function readTableRow(line: string, offset = 0): RowSource {
  const start = line.length - line.trimStart().length
  const end = line.trimEnd().length
  const pipes: number[] = []
  let escaped = false
  for (let i = start; i < end; i++) {
    if (line[i] === '|' && !escaped) pipes.push(i)
    escaped = line[i] === '\\' && !escaped
  }
  const leadingPipe = pipes[0] === start
  const trailingPipe = pipes.at(-1) === end - 1
  let cellStart = leadingPipe ? start + 1 : start
  const cellEnd = trailingPipe ? end - 1 : end
  const cells: CellSource[] = []
  for (const boundary of [...pipes.filter((pos) => pos >= cellStart && pos < cellEnd), cellEnd]) {
    if (boundary < cellStart) break
    const raw = line.slice(cellStart, boundary)
    const text = raw.trim()
    const from = cellStart + (text ? raw.length - raw.trimStart().length : Math.min(1, raw.length))
    cells.push({ from: offset + from, to: offset + from + text.length, text })
    cellStart = boundary + 1
  }
  return { cells, from: offset + start, to: offset + end, leadingPipe, trailingPipe }
}

export function readTableSource(node: SyntaxNode, source: string): RowSource[] {
  const rows: RowSource[] = []
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (row.name === 'TableHeader' || row.name === 'TableDelimiter' || row.name === 'TableRow') {
      const parsed = readTableRow(source.slice(row.from - node.from, row.to - node.from), row.from)
      const syntax = new Map(row.getChildren('TableCell').map(cell => [cell.from, cell]))
      for (const cell of parsed.cells) {
        const match = syntax.get(cell.from)
        if (match?.to === cell.to) cell.syntax = match
      }
      rows.push(parsed)
    }
  }
  return rows
}

export function attachTableRows(table: HTMLTableElement, rows: RowSource[]): void {
  tableRows.set(table, rows)
}

export function sourceForTableCell(table: HTMLTableElement, cell: HTMLTableCellElement) {
  const row = tableRows.get(table)?.[(cell.parentElement as HTMLTableRowElement).rowIndex]
  if (!row) return null
  return { row, column: cell.cellIndex, cell: row.cells[cell.cellIndex] }
}

export function displayCellText(text = ''): string {
  return text.replace(/\\\|/g, '|')
}

export function tableCellChange(
  target: NonNullable<ReturnType<typeof sourceForTableCell>>,
  input: string,
  nextChar: (pos: number) => string,
): { from: number; to: number; insert: string } | null {
  const { row, column, cell } = target
  if (input === (cell?.text ?? '')) return null
  let text = input.trim().replace(/\r\n?|\n/g, '<br>')
    .replace(/(\\*)\|/g, (_, slashes: string) => slashes + (slashes.length % 2 ? '' : '\\') + '|')

  if (!cell) {
    if (!text) return null
    const padding = ' | '.repeat(column - row.cells.length)
    const prefix = row.trailingPipe ? ' ' : ' | '
    return { from: row.to, to: row.to, insert: prefix + padding + text + (row.trailingPipe ? ' |' : '') }
  }

  // Keep an unbordered row a table row when its first cell becomes blank or
  // starts with syntax that Markdown would otherwise read as a block.
  const left = column === 0 && !row.leadingPipe && (!text || BLOCK_PREFIX.test(text)) ? '| ' : ''
  if (!text) {
    const right = column === row.cells.length - 1 && !row.trailingPipe ? ' |' : ''
    text = right
  } else if (nextChar(cell.to) === '|' && /(?:^|[^\\])(?:\\\\)*\\$/.test(text)) {
    // Separate a trailing backslash from the structural pipe.
    text += ' '
  }
  return { from: cell.from, to: cell.to, insert: left + text }
}
