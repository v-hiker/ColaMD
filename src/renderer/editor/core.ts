// 编辑器核心：源码缓冲区是唯一真相。
//
// 这个文件取代了原来的 milkdown/ProseMirror 核心。设计原则见
// docs/editor-architecture.md，一句话：**缓冲区里存的就是文件的字节，渲染是叠在
// 它上面的一层装饰。** 保存时把缓冲区原样写回，不做任何序列化。
//
// 由此得到一条可以在 CI 里断言的纪律：用户没改过的字节，保存时不变。
//
// 这一层需要 DOM（EditorView 要做布局测量）。不依赖 DOM 的那一半在 state.ts 里，
// 验收脚本直接消费那一半，所以保真的证明不需要真实浏览器。

import { tableEditing } from './table-editing'
import { Compartment, EditorState, RangeSet, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, rectangularSelection, crosshairCursor, Decoration } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { undo, redo } from '@codemirror/commands'
import { paragraphLayout } from './paragraph-layout'
import { livePreview, setEditorFocus, setMeasureHost, readingModeField } from './live-preview'
import { listInput } from './list-input'
import { QUOTE_PREFIX_RE, frontmatterEnd, isActiveOrderedListLine, parseListLine } from './list-model'
import { codeBlockSelectAll } from './code-select'
import { searchHighlightField } from './search-highlight'
import { stateExtensions, editableCompartment, bodyStart } from './state'
import { editorTheme } from './source-theme'
import { cursorColors } from './cursor-colors'

export interface EditorOptions {
  /** 初始文本。就是文件的字节。 */
  doc?: string
  /** 文档变化时回调，参数是当前完整文本。 */
  onChange?: (markdown: string) => void
  /** 是否可编辑（放映幻灯片时会锁住）。 */
  editable?: boolean
}

/** 编辑器对外句柄。外壳只认这个，不认 CodeMirror。 */export interface EditorHandle {
  /** 当前缓冲区内容，即文件应有的字节。 */
  getText(): string
  /** 用新文本替换整个文档（换文件、外部改动）。会清空撤销栈。 */
  setText(text: string, clearHistory?: boolean): void
  /** 把光标放到文档末尾的下一行（追加内容用）。 */
  appendText(text: string): void
  /** 聚焦。 */
  focus(): void
  /** 设置是否可编辑。 */
  setEditable(editable: boolean): void
  /** 撤销 / 重做。 */
  undo(): void
  redo(): void
  /** 拿到底层 view（装饰层、搜索面板需要）。 */
  getView(): EditorView
  /** 主题这类外部样式换过之后，让编辑器按新字体重量行高。 */
  remeasure(): void
  /** 销毁。 */
  destroy(): void
}

let handle: EditorHandle | null = null

export function getEditorHandle(): EditorHandle | null {
  return handle
}

/**
 * 列表前缀与任务复选框的原子区间：
 *   1. 任务项的 `[ ]` / `[x]` 换成 checkbox widget，声明为原子区间让左右键一次跨过（#164）；
 *   2. 渲染模式下有序列表项的前缀（前导空格 + `1.` + 空格）同样声明为原子区间，
 *      避免光标停在 `1` 与 `.` 之间误把 `1.` 敲成 `10.` 触发整表跳号。
 */
const listPrefixAtomicRanges = EditorView.atomicRanges.of((view) => {
  const doc = view.state.doc
  const tree = syntaxTree(view.state)
  const fmEnd = frontmatterEnd(doc)
  const ranges: { from: number; to: number }[] = []

  // 1. 有序列表行（只守护真有序项或刚敲完的空 `1. `，不锁普通折行里的 `2026. 敬请期待`）
  const seenLines = new Set<number>()
  for (const vp of view.visibleRanges) {
    const startLine = doc.lineAt(vp.from).number
    const endLine = doc.lineAt(vp.to).number
    for (let ln = startLine; ln <= endLine; ln++) {
      if (seenLines.has(ln)) continue
      seenLines.add(ln)
      const parsed = isActiveOrderedListLine(doc, tree, ln, fmEnd)
      if (!parsed) continue
      const line = doc.line(ln)
      const from = line.from + parsed.quoteLen
      const to = line.from + parsed.contentOffset
      if (to > from) ranges.push({ from, to })
    }
  }

  // 2. 无序任务项复选框（只扫可见视口，避免大文档全树遍历；有序任务项已被上面整段覆盖）
  for (const vp of view.visibleRanges) {
    tree.iterate({
      from: vp.from,
      to: vp.to,
      enter: (node) => {
        if (node.name !== 'TaskMarker') return
        const line = doc.lineAt(node.from)
        const parsed = parseListLine(line.text)
        if (!parsed || parsed.kind === 'ordered') return
        const prefix = doc.sliceString(line.from, node.from)
        const quoteLen = QUOTE_PREFIX_RE.exec(prefix)?.[0].length ?? 0
        const listPart = prefix.slice(quoteLen)
        const from = /^[ \t]*(?:[-*+]|\d+[.)]) +$/.test(listPart) ? line.from + quoteLen : node.from
        const trailing = doc.sliceString(node.to, Math.min(node.to + 1, line.to)) === ' ' ? node.to + 1 : node.to
        if (trailing > from) ranges.push({ from, to: trailing })
      },
    })
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: { from: number; to: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.from <= last.to) {
      if (r.to > last.to) last.to = r.to
    } else {
      merged.push({ ...r })
    }
  }
  return RangeSet.of(merged.map((r) => ATOMIC_MARK.range(r.from, r.to)), true)
})

const ATOMIC_MARK = Decoration.replace({})

/**
 * 「可编辑 / 只读」这套配置。
 *
 * 只读时 CM6 的 editable facet 必须是 false —— 只有它关掉，CM6 才不接管选区
 * （否则它会把用户拖选出来的 DOM 选区同步回自己的 selection，选区立刻塌掉，
 * 复制出来的是表格源码 `| 维度 | 说明 |`）。
 *
 * 但 contenteditable 属性不能跟着变成 false：Chromium 里那样的区域连鼠标拖选
 * 都不允许开始（实测 rangeCount 0）。所以属性那一层单独在 keepSelectableWhenReadOnly
 * 里钉住，facet 和 DOM 属性在这里拆成两件事。
 */
function editabilityExtensions(editable: boolean): Extension {
  return [
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
    EditorState.changeFilter.of((tr) => editable || !tr.docChanged),
  ]
}

/**
 * 只读期间把 DOM 的 contenteditable 属性钉成 true，让浏览器肯从正文里开始拖选。
 *
 * CM6 每次 update 之后会按 editable facet 重设这个属性，所以用 MutationObserver
 * 盯着，改回去就再改回来。
 */
let contentEditableGuard: MutationObserver | null = null

function keepSelectableWhenReadOnly(view: EditorView, readOnly: boolean): void {
  contentEditableGuard?.disconnect()
  contentEditableGuard = null
  if (!readOnly) return
  const force = (): void => {
    if (view.contentDOM.getAttribute('contenteditable') !== 'true') {
      view.contentDOM.setAttribute('contenteditable', 'true')
    }
  }
  force()
  contentEditableGuard = new MutationObserver(force)
  contentEditableGuard.observe(view.contentDOM, { attributes: true, attributeFilter: ['contenteditable'] })
}

export function createEditorCore(parent: HTMLElement, options: EditorOptions = {}): EditorHandle {
  const changeListener = options.onChange
  const themeLayout = new Compartment()
  const remeasureTheme = EditorView.theme({})

  const extension = [
    // 状态层：语言、高亮、撤销栈、缩进、快捷键（无 DOM，可进 harness）
    stateExtensions(),
    // 以下是 view 层：选区绘制、拖放光标、特殊字符、主题
    drawSelection(),
    cursorColors,
    // 自动换行。CodeMirror 默认**不换行**，长行会横向滚动；markdown 正文必须换行。
    EditorView.lineWrapping,
    dropCursor(),
    highlightSpecialChars(),
    rectangularSelection(),
    crosshairCursor(),
    editorTheme,
    themeLayout.of([]),
    // 装饰层：把源码画成所见即所得。它只画不写，所以装在这里不会影响
    // 「没改过的字节不许变」这条纪律。
    livePreview,
    paragraphLayout,
    // 焦点变化要重算装饰：只有**正在编辑**的那一行才显示源码（见 live-preview 的 setEditorFocus）。
    // 用 DOM 事件而不是 EditorView.focusChangeEffect，是因为后者在创建时就已带焦点的编辑器上
    // 不会触发；下面创建完 view 之后补了一次初始值。
    EditorView.domEventHandlers({
      focus: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(true) })
        return false
      },
      blur: (_event, view) => {
        if (view.dom.isConnected) view.dispatch({ effects: setEditorFocus.of(false) })
        return false
      },
      // 复制兜底：widget（表格、图、公式）里的文字不在 CodeMirror 的选择模型里。
      // 阅读态下拖选一张表，原生选区是有内容的，但 state.selection 仍然是空的 —— CM6 的
      // copy 处理只在它自己有选区时接管，于是两边都不动，剪贴板最后是空的
      // （2026-11-20 用户报的「阅读模式表格内容复制不了」）。
      // 这里补一条：CM6 没有选区、而原生选区有内容时，用原生文本写剪贴板并拦下事件。
      // 编辑态不受影响——那时 CM6 自己一定有选区，下面直接放行。
      copy: (event, view) => {
        if (!view.state.selection.main.empty) return false
        const selected = document.getSelection()
        const text = selected?.toString() ?? ''
        if (text === '') return false
        event.clipboardData?.setData('text/plain', text)
        event.preventDefault()
        return true
      },
    }),
    // 回车续列表。这是编辑器的输入手感，与渲染无关，所以单独一个模块。
    listInput,
    // 代码块里的 ⌘A 先只选这段代码（见 code-select.ts）
    codeBlockSelectAll,
    // 检索高亮。面板靠 effect 改它，而 effect 得有 StateField 接住；
    // 不装这一条，检索面板会以为高亮画上了，实际什么也没发生。
    searchHighlightField,
    listPrefixAtomicRanges,
    tableEditing,
    editableCompartment.of(editabilityExtensions(options.editable ?? true)),
    // 文档变化的唯一出口：把新文本交给外壳
    EditorView.updateListener.of((update) => {
      if (update.docChanged && changeListener) {
        changeListener(update.state.doc.toString())
      }
    }),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: options.doc ?? '', extensions: extension }),
    parent,
  })
  // 异步画完的图会改块高，widget 拿不到 view，由这里记一份（见 live-preview 的 remeasureAfterDraw）
  setMeasureHost(view)

  // 阅读态下，widget（表格、图片、mermaid、块公式）里的 mousedown 不要被编辑器接管。
  //
  // CM6 的 mousedown 会 preventDefault 来自己摆光标，浏览器于是不会开始原生选择：
  // 拖选一张表，选区压根建不起来（实测 rangeCount 0），后面 copy 再怎么补救都没用。
  // 阅读模式没有光标要摆，这一下放行给浏览器，拖选才有内容可复制。
  //
  // 用 capture 阶段：CM6 的内置 handlers 注册在同一个节点的冒泡阶段，比这里晚。
  view.contentDOM.addEventListener('mousedown', (event) => {
    if (!(view.state.field(readingModeField, false) ?? false)) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.cm-md-table-scroll, .cm-md-image, .cm-md-mermaid, .cm-md-math-block')) {
      event.stopPropagation()
    }
  }, true)

  // 创建时就已经带焦点的编辑器不会触发 focus 事件（它一直是焦点），这里补一次初始值。
  // 不做这一步，用户一打开文件就打字，标记却不会显形。
  if (view.hasFocus) view.dispatch({ effects: setEditorFocus.of(true) })

  const api: EditorHandle = {
    getText: () => view.state.doc.toString(),

    setText(text: string, clearHistory = false): void {
      if (view.state.doc.toString() === text) return
      // 换文件时必须把撤销栈清掉，否则撤销会跨文档串味。光标也要落到正文开头：
      // 属性区是收起来的，停在它里面敲出来的字会看不见（见 state.ts 的 bodyStart）。
      // 同步源码视图的内容时，程序化替换可以通过只读输入锁。
      const next = clearHistory
        ? EditorState.create({ doc: text, selection: { anchor: bodyStart(text) }, extensions: extension })
        : view.state.update({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          filter: false,
        }).state
      view.setState(next)
    },

    appendText(text: string): void {
      const end = view.state.doc.length
      const needsBreak = end > 0 && !view.state.doc.toString().endsWith('\n')
      view.dispatch({
        changes: { from: end, insert: (needsBreak ? '\n' : '') + text },
        selection: { anchor: end + (needsBreak ? 1 : 0) + text.length },
      })
      view.focus()
    },

    focus: () => view.focus(),
    setEditable(editable: boolean): void {
      view.dispatch({ effects: editableCompartment.reconfigure(editabilityExtensions(editable)) })
      keepSelectableWhenReadOnly(view, !editable)
    },
    undo: () => { undo(view) },
    redo: () => { redo(view) },
    getView: () => view,
    remeasure(): void {
      // 短文档的总高度可能被 min-height 撑住，requestMeasure 不会重测行高。
      // 公开 API 里只有 theme 变化会让 CM 重量内容：在空主题和无之间切一次，不改文档或撤销栈。
      view.dispatch({ effects: themeLayout.reconfigure(themeLayout.get(view.state) === remeasureTheme ? [] : remeasureTheme) })
    },
    destroy(): void {
      contentEditableGuard?.disconnect()
      contentEditableGuard = null
      setMeasureHost(null)
      view.destroy()
      handle = null
    },
  }

  handle = api
  return api
}
