import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { GFM, parser as lezer } from '@lezer/markdown'
import { createCjkEmphasis } from './cjk-emphasis'

export interface MarkdownNode {
  type: string
  value?: string
  lang?: string | null
  depth?: number
  ordered?: boolean
  start?: number
  url?: string
  alt?: string
  align?: Array<'left' | 'right' | 'center' | null>
  children?: MarkdownNode[]
}

const parser = unified().use(remarkParse).use(remarkGfm)

export function parseWordMarkdown(markdown: string): MarkdownNode {
  // Remark implements standard CommonMark. Use the editor's detector to mark
  // the exact boundaries where we also allow emphasis adjacent to CJK quotes.
  const separator = ['\u2000', '\u2001', '\u2004', '\u2009', '\u202F'].find((space) => !markdown.includes(space))
  if (!separator || !markdown.includes('*')) return parser.parse(markdown) as MarkdownNode
  const boundaries = new Set<number>()
  lezer.configure([GFM, createCjkEmphasis((position) => boundaries.add(position))]).parse(markdown)
  if (!boundaries.size) return parser.parse(markdown) as MarkdownNode

  const pieces: string[] = []
  let previous = 0
  for (const position of [...boundaries].sort((a, b) => a - b)) {
    pieces.push(markdown.slice(previous, position), separator)
    previous = position
  }
  pieces.push(markdown.slice(previous))
  const tree = parser.parse(pieces.join('')) as MarkdownNode
  const restoreText = (node: MarkdownNode) => {
    if (node.type === 'text' && node.value) node.value = node.value.replaceAll(separator, '')
    if (node.type === 'image' && node.alt) node.alt = node.alt.replaceAll(separator, '')
    node.children?.forEach(restoreText)
  }
  restoreText(tree)
  return tree
}

export function isMermaid(node: MarkdownNode): boolean {
  return node.type === 'code' && node.lang?.toLowerCase() === 'mermaid'
}

export function* mermaidBlocks(node: MarkdownNode): Generator<string> {
  if (isMermaid(node) && node.value?.trim()) yield node.value
  for (const child of node.children ?? []) yield* mermaidBlocks(child)
}
