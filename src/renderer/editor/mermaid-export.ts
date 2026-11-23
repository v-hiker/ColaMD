import { currentWordTheme } from '../word-theme'
import {
  WORD_CONTENT_WIDTH, WORD_DIAGRAM_HEIGHT, WORD_TWIPS_PER_PIXEL,
  type WordExportPayload, type WordTheme,
} from '../../shared/word-export'
import { renderMermaid } from './mermaid-bridge'

interface Diagram {
  svg: Element
  width: number
  height: number
}

async function drawDiagram(code: string, palette: Record<string, string>): Promise<Diagram | null> {
  const source = await renderMermaid(code, { palette })
  const svg = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement
  if (svg.localName !== 'svg') return null

  const [,, width, height] = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return null
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  return { svg, width, height }
}

function paperPalette(theme: WordTheme): Record<string, string> {
  return {
    '--pele-bg': '#ffffff',
    '--pele-fg': '#' + theme.text,
    '--pele-muted': '#' + theme.text,
    '--pele-line': '#' + theme.text,
    '--pele-surface': '#' + theme.tableHeader,
    '--pele-surface-alt': '#' + theme.codeBackground,
    '--pele-border': '#' + theme.border,
    '--pele-accent': '#' + theme.accent,
  }
}

async function diagramPNG(code: string, palette: Record<string, string>): Promise<string | null> {
  let diagram = await drawDiagram(code, palette)
  if (!diagram) return null
  const pageWidth = WORD_CONTENT_WIDTH / WORD_TWIPS_PER_PIXEL
  const scaleOnPage = ({ width, height }: Diagram) => Math.min(pageWidth / width, WORD_DIAGRAM_HEIGHT / height)

  // Very wide left-to-right flowcharts have tiny labels on a portrait page.
  // Try a vertical layout for the embedded image and keep the larger result.
  if (diagram.width > pageWidth * 1.65 && diagram.width / diagram.height > 3) {
    const verticalCode = code.replace(/^(\s*(?:flowchart|graph)[ \t]+)(LR|RL)\b/m,
      (_, start, direction) => start + (direction === 'LR' ? 'TB' : 'BT'))
    if (verticalCode !== code) {
      const vertical = await drawDiagram(verticalCode, palette).catch(() => null)
      if (vertical && scaleOnPage(vertical) > scaleOnPage(diagram)) diagram = vertical
    }
  }

  const source = new XMLSerializer().serializeToString(diagram.svg)
  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source)
  await image.decode()

  const scale = Math.min(2, 4096 / Math.max(diagram.width, diagram.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(diagram.width * scale))
  canvas.height = Math.max(1, Math.round(diagram.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

export async function markdownForWord(content: string, sourcePath: string | null): Promise<WordExportPayload> {
  const theme = currentWordTheme()
  const diagrams: Record<string, string> = Object.create(null)
  if (/\bmermaid\b/i.test(content)) {
    const parser = await import('../../shared/word-markdown')
    const palette = paperPalette(theme)
    for (const code of new Set(parser.mermaidBlocks(parser.parseWordMarkdown(content)))) {
      const png = await diagramPNG(code, palette).catch(() => null)
      if (png) diagrams[code] = png
    }
  }
  return { content, diagrams, theme, sourcePath }
}
