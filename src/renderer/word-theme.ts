import { DEFAULT_WORD_THEME, type WordTextMetrics, type WordTheme } from '../shared/word-export'

type RGB = [number, number, number]
const WHITE: RGB = [255, 255, 255]
const INK: RGB = [36, 41, 47]

function blend(base: RGB, tint: RGB, strength: number): RGB {
  return [0, 1, 2].map((index) => Math.round(base[index] * (1 - strength) + tint[index] * strength)) as RGB
}

function luminance(color: RGB): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return red * 0.2126 + green * 0.7152 + blue * 0.0722
}

function paperInk(color: RGB): RGB {
  while (luminance(color) > 0.18) color = blend(color, INK, 0.22)
  return color
}

function hex(color: RGB): string {
  return color.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function textMetrics(style: CSSStyleDeclaration): WordTextMetrics {
  const size = parseFloat(style.fontSize)
  return { size, lineHeight: parseFloat(style.lineHeight) || size * 1.35 }
}

export function currentWordTheme(): WordTheme {
  const editor = document.querySelector('#editor .cm-content') ?? document.body
  const style = getComputedStyle(editor)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return DEFAULT_WORD_THEME

  const paperColor = (value: string, fallback: string): RGB => {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 1, 1)
    context.fillStyle = `#${fallback}`
    context.fillStyle = value.trim()
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
    return [red, green, blue]
  }
  const color = (variable: string, fallback: string) => paperColor(style.getPropertyValue(variable), fallback)

  const headingProbe = document.createElement('div')
  headingProbe.className = 'cm-content'
  headingProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'
  headingProbe.setAttribute('aria-hidden', 'true')
  editor.after(headingProbe)
  const headings: WordTextMetrics[] = []
  try {
    for (let level = 1; level <= 6; level++) {
      const heading = document.createElement('div')
      heading.className = 'cm-line cm-md-atxheading' + level
      headingProbe.append(heading)
      const headingStyle = getComputedStyle(heading)
      const metrics = textMetrics(headingStyle)
      if (parseFloat(headingStyle.borderBottomWidth) > 0) {
        metrics.rule = hex(paperColor(headingStyle.borderBottomColor, DEFAULT_WORD_THEME.border))
      }
      headings.push(metrics)
    }
  } finally {
    headingProbe.remove()
  }

  const fontFamily = style.fontFamily.split(',').at(-1)?.trim()
  const font = fontFamily === 'serif' ? 'serif' : fontFamily === 'monospace' ? 'mono' : 'sans'
  const theme = DEFAULT_WORD_THEME
  const dark = luminance(color('--bg-color', 'FFFFFF')) < 0.3
  const accent = paperInk(color('--link-color', theme.accent))
  return {
    font,
    fontStack: style.fontFamily,
    body: textMetrics(style),
    headings,
    text: hex(dark ? INK : paperInk(color('--text-color', theme.text))),
    accent: hex(accent),
    border: hex(dark ? blend(WHITE, accent, 0.19) : color('--border-color', theme.border)),
    quoteBorder: hex(dark ? blend(WHITE, accent, 0.24) : color('--blockquote-border', theme.quoteBorder)),
    tableHeader: hex(dark ? blend(WHITE, accent, 0.09) : blend(WHITE, color('--table-header-bg', theme.tableHeader), 0.8)),
    codeBackground: hex(dark ? blend(WHITE, accent, 0.055) : blend(WHITE, color('--code-bg', theme.codeBackground), 0.6)),
  }
}
