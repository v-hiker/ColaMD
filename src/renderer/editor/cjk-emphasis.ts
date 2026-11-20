import type { MarkdownConfig } from '@lezer/markdown'

const ASTERISK = '*'.charCodeAt(0)
const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const PUNCTUATION = /[\p{P}\p{S}]/u
const PAIRS = new Map([
  ['“', '”'], ['‘', '’'], ['（', '）'], ['「', '」'], ['『', '』'],
  ['《', '》'], ['〈', '〉'], ['【', '】'], ['〔', '〕'],
])
const CLOSING_PUNCTUATION = new Set(PAIRS.values())

const isBoundary = (char: string) => char === '' || /\s/u.test(char) || PUNCTUATION.test(char)

/** Allow simple asterisk spans next to CJK brackets and quotation marks. */
export const cjkEmphasis: MarkdownConfig = {
  parseInline: [{
    name: 'CJKEmphasis',
    before: 'Emphasis',
    parse(cx, next, start) {
      if (next !== ASTERISK || cx.char(start - 1) === ASTERISK) return -1
      const size = cx.char(start + 1) === ASTERISK ? 2 : 1
      const contentFrom = start + size
      if (cx.char(contentFrom) === ASTERISK) return -1

      const nextStar = cx.text.indexOf('*', contentFrom - cx.offset)
      if (nextStar < 0) return -1
      const contentTo = nextStar + cx.offset
      const end = contentTo + size
      if (cx.slice(contentTo, end) !== '*'.repeat(size) || cx.char(end) === ASTERISK) return -1

      const content = cx.slice(contentFrom, contentTo)
      if (content === '' || content !== content.trim()) return -1
      const [first] = content
      const last = Array.from(content.slice(-2)).at(-1) ?? ''
      const before = Array.from(cx.slice(Math.max(cx.offset, start - 2), start)).at(-1) ?? ''
      const [after = ''] = cx.slice(end, end + 2)
      const cjkOpening = CJK_TEXT.test(before) && PAIRS.get(first) === last
      const cjkClosing = CLOSING_PUNCTUATION.has(last) && CJK_TEXT.test(after)
      if (!cjkOpening && !cjkClosing) return -1
      if ((!cjkOpening && PUNCTUATION.test(first) && !isBoundary(before)) ||
          (!cjkClosing && PUNCTUATION.test(last) && !isBoundary(after))) return -1

      // Let the standard parser handle ambiguous boundaries in escapes, code and links.
      if (/[\r\n\\`<>\[\]]/u.test(content)) return -1
      return cx.addElement(cx.elt(size === 2 ? 'StrongEmphasis' : 'Emphasis', start, end, [
        cx.elt('EmphasisMark', start, contentFrom),
        ...cx.parser.parseInline(content, contentFrom),
        cx.elt('EmphasisMark', contentTo, end),
      ]))
    },
  }],
}
