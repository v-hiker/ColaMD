import { isolateHistory } from '@codemirror/commands'
import type { ChangeDesc, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isChinese } from '../ui-language'
import { sourceForTableCell, tableCellChange } from './table-source'

interface CellAddress {
  tableFrom: number
  row: number
  column: number
}

interface CellEdit {
  doc: Text
  table: HTMLTableElement
  cell: HTMLTableCellElement
  input: HTMLTextAreaElement
  target: NonNullable<ReturnType<typeof sourceForTableCell>>
}

const activeEdits = new WeakMap<EditorView, CellEdit>()
const tableOwners = new WeakMap<HTMLElement, EditorView>()

export function finishCellEdit(view: EditorView, confirm = true): { position: number; changes: ChangeDesc | null } | null {
  const edit = activeEdits.get(view)
  if (!edit) return null
  activeEdits.delete(view)
  tableOwners.delete(edit.table)
  edit.input.blur()
  const value = edit.input.value
  edit.input.remove()
  edit.cell.classList.remove('cm-md-table-cell-editing')

  if (!confirm || view.state.readOnly || view.state.doc !== edit.doc) return null
  const position = edit.target.cell?.from ?? edit.target.row.to
  const change = tableCellChange(edit.target, value, (pos) => view.state.sliceDoc(pos, pos + 1))
  if (!change) return { position, changes: null }
  const transaction = view.state.update({ changes: change, annotations: isolateHistory.of('full') })
  view.dispatch(transaction)
  return { position: change.from, changes: transaction.changes }
}

export function finishRemovedTableEdit(table: HTMLElement): void {
  const view = tableOwners.get(table)
  const edit = view && activeEdits.get(view)
  // Removing a widget can happen inside CodeMirror's update. Commit after it finishes.
  if (view && edit) queueMicrotask(() => {
    if (activeEdits.get(view) === edit && !table.isConnected) finishCellEdit(view)
  })
}

function addressOf(table: HTMLTableElement, cell: HTMLTableCellElement): CellAddress {
  return {
    tableFrom: Number(table.dataset.sourceFrom),
    row: (cell.parentElement as HTMLTableRowElement).rowIndex,
    column: cell.cellIndex,
  }
}

function openAt(view: EditorView, address: CellAddress, changes: ChangeDesc | null | undefined): boolean {
  const from = changes?.mapPos(address.tableFrom, -1) ?? address.tableFrom
  const table = view.contentDOM.querySelector<HTMLTableElement>(
    'table.cm-md-table-widget[data-source-from="' + from + '"]',
  )
  const cell = table?.rows[address.row]?.cells[address.column]
  if (!table || !cell) return false
  return openCell(view, table, cell)
}

function adjacentCell(edit: CellEdit, backward: boolean): CellAddress | null {
  const address = addressOf(edit.table, edit.cell)
  const row = edit.table.rows[address.row]
  const column = address.column + (backward ? -1 : 1)
  if (row.cells[column]) return { ...address, column }
  const rowIndex = address.row + (backward ? -1 : 1)
  const nextRow = edit.table.rows[rowIndex]
  return nextRow ? { ...address, row: rowIndex, column: backward ? nextRow.cells.length - 1 : 0 } : null
}

function openCell(view: EditorView, table: HTMLTableElement, cell: HTMLTableCellElement): boolean {
  if (view.state.readOnly || !table.isConnected) return false
  const target = sourceForTableCell(table, cell)
  if (!target) return false
  const input = document.createElement('textarea')
  input.className = 'cm-md-table-cell-input'
  input.setAttribute('aria-label', isChinese() ? '编辑表格单元格' : 'Edit table cell')
  input.value = target.cell?.text ?? ''
  const edit = { doc: view.state.doc, table, cell, input, target }
  activeEdits.set(view, edit)
  tableOwners.set(table, view)
  cell.classList.add('cm-md-table-cell-editing')
  cell.append(input)
  input.focus({ preventScroll: true })
  input.setSelectionRange(input.value.length, input.value.length)

  input.addEventListener('blur', () => {
    queueMicrotask(() => {
      if (activeEdits.get(view) === edit && document.activeElement !== input) finishCellEdit(view)
    })
  })
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (!['Enter', 'Tab', 'Escape'].includes(event.key) || (event.key === 'Enter' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    const next = event.key === 'Tab' ? adjacentCell(edit, event.shiftKey) : null
    const result = finishCellEdit(view, event.key !== 'Escape')
    if (!next || !openAt(view, next, result?.changes)) view.focus()
  })
  return true
}

export function installTableCellEditing(root: HTMLElement, view: EditorView): void {
  root.addEventListener('mousedown', (event) => {
    if (event.defaultPrevented || event.button !== 0 || view.state.readOnly || !(event.target instanceof HTMLElement)) return
    if (event.target.closest('.cm-md-table-cell-input')) return
    const cell = event.target.closest<HTMLTableCellElement>('th, td')
    const table = cell?.closest<HTMLTableElement>('table.cm-md-table-widget')
    if (!table || !cell) return
    event.preventDefault()
    event.stopPropagation()
    const address = addressOf(table, cell)
    const result = finishCellEdit(view)
    openAt(view, address, result?.changes)
  }, true)
}
