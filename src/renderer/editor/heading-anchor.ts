import { decodeString } from 'micromark-util-decode-string'
import type { SyntaxNode } from '@lezer/common'
import { frontmatterRange } from './math-scan'
import { markdownParser } from './state'

/** 提取标题的显示文字，保留代码和转义标点的字面值。 */
function headingText(source: string, heading: SyntaxNode): string {
  let offset = heading.from
  let text = ''
  heading.cursor().iterate(
    (node) => {
      const { name, from, to } = node
      if (from < offset) return
      let end = to
      let replacement = ''
      switch (name) {
        case 'Escape':
        case 'Entity':
          replacement = decodeString(source.slice(from, to))
          break
        case 'CodeMark':
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'HeaderMark':
        case 'QuoteMark':
          break
        case 'LinkMark': {
          const parent = node.node.parent
          if (!parent || !parent.getChildren('LinkMark').some(mark => source[mark.from] === '(')) return
          if (source[from] === ']') end = parent.to
          break
        }
        default:
          return
      }
      text += source.slice(offset, from) + replacement
      offset = end
    },
  )
  return (text + source.slice(offset, heading.to)).trim().replace(/[ \t]*\r?\n[ \t]*/g, ' ')
}

/** 从完整语法树取标题，大纲和锚点导航使用同一份行号和可见文字。 */
export function documentHeadings(markdown: string): { level: number; title: string; line: number }[] {
  const headings: { level: number; title: string; line: number }[] = []
  const front = frontmatterRange(markdown)
  let line = 0
  let nextLineBreak = markdown.indexOf('\n')
  markdownParser.parse(markdown).iterate({
    enter(node) {
      if (front && node.name !== 'Document' && node.from < front.to) return false
      if (!/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return
      while (nextLineBreak !== -1 && nextLineBreak < node.from) {
        line++
        nextLineBreak = markdown.indexOf('\n', nextLineBreak + 1)
      }
      const title = headingText(markdown, node.node)
      if (title) headings.push({ level: Number(node.name.at(-1)), title, line })
      return false
    },
  })
  return headings
}

/** Find headings outside the viewport too, ignoring heading-like code blocks. */
export function headingAnchorLine(markdown: string, fragment: string): number | null {
  let target = fragment
  try { target = decodeURIComponent(fragment) } catch { /* use the literal fragment */ }
  const slugify = (text: string): string => text.trim().toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s+/g, '-')
  const seen = new Map<string, number>()
  const literal = target.toLowerCase()
  const normalized = slugify(target)
  for (const { title, line } of documentHeadings(markdown)) {
    const base = slugify(title)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count ? `${base}-${count}` : base
    if (slug === literal || slug === normalized) return line
  }
  return null
}
