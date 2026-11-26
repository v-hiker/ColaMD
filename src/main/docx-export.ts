import { nativeImage, type NativeImage } from 'electron'
import { basename, dirname, extname, isAbsolute, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
  type IParagraphOptions,
} from 'docx'
import {
  DEFAULT_WORD_THEME, WORD_CONTENT_WIDTH, WORD_DIAGRAM_HEIGHT, WORD_PAGE, WORD_TWIPS_PER_PIXEL,
  type WordFontFamilies, type WordTextMetrics, type WordTheme,
} from '../shared/word-export'
import { isMermaid, parseWordMarkdown, type MarkdownNode } from '../shared/word-markdown'
import { distributeWidth } from '../shared/table-column-widths'

export interface DocxExportInput {
  content: string
  sourcePath: string | null
  diagrams?: Record<string, string>
  theme?: unknown
  fonts?: WordFontFamilies
}

const platform = process.platform
const bodyFonts = platform === 'win32'
  ? { sans: ['Calibri', 'Microsoft YaHei'], serif: ['Georgia', 'SimSun'], mono: ['Consolas', 'Microsoft YaHei'] }
  : platform === 'darwin'
    ? { sans: ['Arial', 'PingFang SC'], serif: ['Georgia', 'Songti SC'], mono: ['Menlo', 'PingFang SC'] }
    : { sans: ['Liberation Sans', 'Noto Sans CJK SC'], serif: ['Liberation Serif', 'Noto Serif CJK SC'], mono: ['DejaVu Sans Mono', 'Noto Sans CJK SC'] }

function wordFont(kind: WordTheme['font'], fonts?: WordFontFamilies) {
  const [fallbackLatin, fallbackEastAsia] = bodyFonts[kind]
  const latin = fonts?.latin ?? fallbackLatin
  // Windows Word's fixed-layout export can lose the weight axis of these CJK
  // families. Use the equivalent static Windows face for legible bold text.
  const eastAsia = platform === 'win32' && /^(Noto Sans SC|Noto Serif SC)$/i.test(fonts?.eastAsia ?? '')
    ? fallbackEastAsia
    : fonts?.eastAsia ?? fallbackEastAsia
  return { ascii: latin, hAnsi: latin, cs: latin, eastAsia }
}

const CODE_FONT = wordFont('mono')
const CODE_SIZE = 18
const CELL_SIZE = 20
const CELL_PADDING = 140
const PAGE_IMAGE_WIDTH = Math.floor(WORD_CONTENT_WIDTH / WORD_TWIPS_PER_PIXEL)
const CELL_SPACING = { before: 0, after: 0, line: 290 }

function readTheme(input: unknown): WordTheme {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const color = (key: 'text' | 'accent' | 'border' | 'quoteBorder' | 'tableHeader' | 'codeBackground') => {
    const value = source[key]
    return typeof value === 'string' && /^[\da-f]{6}$/i.test(value) ? value : DEFAULT_WORD_THEME[key]
  }
  const body = readMetrics(source.body)
  const headingMetrics = Array.isArray(source.headings) ? source.headings.slice(0, 6).map(readMetrics) : []
  return {
    font: source.font === 'serif' || source.font === 'mono' ? source.font : 'sans',
    body,
    headings: headingMetrics.length === 6 && headingMetrics.every((heading) => !!heading) ? headingMetrics : undefined,
    text: color('text'),
    accent: color('accent'),
    border: color('border'),
    quoteBorder: color('quoteBorder'),
    tableHeader: color('tableHeader'),
    codeBackground: color('codeBackground'),
  }
}

function readMetrics(value: unknown): WordTextMetrics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { size, lineHeight, rule } = value as Record<string, unknown>
  if (typeof size !== 'number' || !(size >= 6 && size <= 100) ||
      typeof lineHeight !== 'number' || !(lineHeight >= 6 && lineHeight <= 250)) return undefined
  return { size, lineHeight, rule: typeof rule === 'string' && /^[\da-f]{6}$/i.test(rule) ? rule : undefined }
}

function documentStyles(theme: WordTheme, fonts?: WordFontFamilies) {
  const font = wordFont(theme.font, fonts)
  const headingFont = fonts?.headingEastAsia ? wordFont(theme.font, { latin: fonts.latin, eastAsia: fonts.headingEastAsia }) : font
  const body = theme.body ?? { size: 16, lineHeight: 28 }
  const normal = {
    run: { font, size: Math.round(body.size * 1.5), color: theme.text },
    paragraph: { spacing: { after: 130, line: Math.round(body.lineHeight * WORD_TWIPS_PER_PIXEL), lineRule: 'atLeast' as const }, widowControl: true },
  }
  const heading = (level: number, ratio: number, before: number, after: number) => {
    const metrics = theme.headings?.[level - 1]
    const size = metrics?.size ?? body.size * ratio
    const rule = metrics?.rule
    return {
      run: { font: headingFont, size: Math.round(size * 1.5), color: theme.text, bold: true },
      paragraph: {
        keepNext: true,
        keepLines: true,
        spacing: { before, after, line: Math.round((metrics?.lineHeight ?? size * 1.25) * WORD_TWIPS_PER_PIXEL), lineRule: 'atLeast' as const },
        border: rule ? { bottom: { style: 'single' as const, color: rule, size: 4, space: 2 } } : undefined,
      },
    }
  }
  return {
    default: {
      document: normal,
      heading1: heading(1, 2, 360, 200),
      heading2: heading(2, 1.5, 320, 150),
      heading3: heading(3, 1.25, 260, 125),
      heading4: heading(4, 1, 220, 100),
      heading5: heading(5, 1, 200, 95),
      heading6: heading(6, 1, 180, 90),
      hyperlink: { run: { color: theme.accent, underline: { type: 'none' as const } } },
    },
    paragraphStyles: [
      { id: 'Normal', name: 'Normal', ...normal },
      {
        id: 'ColaMDTableText',
        name: 'ColaMD Table Text',
        basedOn: 'Normal',
        run: { font, color: theme.text, size: CELL_SIZE },
        paragraph: { spacing: CELL_SPACING },
      },
      {
        id: 'ColaMDCaption',
        name: 'ColaMD Caption',
        basedOn: 'Normal',
        run: { font, color: '5B636D', size: 18 },
        paragraph: { alignment: AlignmentType.CENTER, keepLines: true, spacing: { before: 70, after: 150, line: 255 } },
      },
    ],
  }
}

function bodyParagraph(options: IParagraphOptions): Paragraph {
  return new Paragraph({ style: 'Normal', ...options })
}

// Code line breaks must be separate runs to survive as line breaks in Word.
function codeRuns(value: string): ParagraphChild[] {
  const lines = value.replace(/\n+$/, '').split('\n')
  const runs: ParagraphChild[] = []
  lines.forEach((line, index) => {
    if (index > 0) runs.push(new TextRun({ break: 1, font: CODE_FONT, size: CODE_SIZE }))
    if (line !== '') runs.push(new TextRun({ text: line, font: CODE_FONT, size: CODE_SIZE, noProof: true }))
  })
  return runs.length > 0 ? runs : [new TextRun({ text: '', font: CODE_FONT, size: CODE_SIZE })]
}

const HEADINGS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
]

function textContent(node: MarkdownNode): string {
  if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value ?? ''))) return '\n'
  return node.value ?? node.children?.map(textContent).join('') ?? node.alt ?? ''
}

interface Media {
  data: Buffer
  width: number
  height: number
}

interface ExportContext {
  input: DocxExportInput
  theme: WordTheme
  images: Map<string, Media | null>
}

function mediaFromImage(image: NativeImage): Media | null {
  if (image.isEmpty()) return null
  return { data: image.toPNG(), ...image.getSize() }
}

function localImage(url: string | undefined, context: ExportContext): Media | null {
  if (!url || /^(https?:|blob:)/i.test(url)) return null
  if (context.images.has(url)) return context.images.get(url) ?? null
  let media: Media | null = null
  try {
    if (url.startsWith('data:image/')) {
      media = mediaFromImage(nativeImage.createFromDataURL(url))
    } else {
      const sourcePath = context.input.sourcePath
      const decoded = url.startsWith('file:') ? fileURLToPath(url) : decodeURIComponent(url)
      const path = isAbsolute(decoded) ? decoded : sourcePath ? resolve(dirname(sourcePath), decoded) : null
      if (path) media = mediaFromImage(nativeImage.createFromPath(path))
    }
  } catch {
    // Keep the image description when the path or embedded data is invalid.
  }
  context.images.set(url, media)
  return media
}

function imageRun(media: Media, alt: string, maxWidth: number, maxHeight: number): ImageRun {
  const scale = Math.min(1, maxWidth / media.width, maxHeight / media.height)
  return new ImageRun({
    type: 'png',
    data: media.data,
    altText: { name: alt, title: alt, description: alt },
    transformation: { width: Math.max(1, Math.round(media.width * scale)), height: Math.max(1, Math.round(media.height * scale)) },
  })
}

function altRun(alt?: string): TextRun {
  return new TextRun({ text: alt ? '[' + alt + ']' : '[image]', italics: true })
}

function figure(media: Media, caption: string, maxWidth: number, maxHeight: number, inTable = false): Paragraph[] {
  const paragraphs = [new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: Boolean(caption),
    spacing: inTable ? CELL_SPACING : { before: 110, after: caption ? 0 : 150 },
    children: [imageRun(media, caption, maxWidth, maxHeight)],
  })]
  if (caption) paragraphs.push(new Paragraph({ style: 'ColaMDCaption', text: caption }))
  return paragraphs
}

type InlineStyle = { bold?: boolean; italics?: boolean; strike?: boolean; style?: string }

function inlineRuns(nodes: MarkdownNode[] | undefined, context: ExportContext, style: InlineStyle = {}, width = PAGE_IMAGE_WIDTH): ParagraphChild[] {
  const runs: ParagraphChild[] = []
  for (const node of nodes ?? []) {
    if (node.type === 'text') {
      runs.push(new TextRun({ text: node.value ?? '', ...style }))
    } else if (node.type === 'break' || (node.type === 'html' && /^<br\s*\/?>$/i.test(node.value ?? ''))) {
      runs.push(new TextRun({ break: 1, ...style }))
    } else if (node.type === 'inlineCode') {
      runs.push(new TextRun({
        ...style, text: node.value ?? '', font: CODE_FONT, size: CODE_SIZE,
        shading: { fill: context.theme.codeBackground }, noProof: true,
      }))
    } else if (node.type === 'strong') {
      runs.push(...inlineRuns(node.children, context, { ...style, bold: true }, width))
    } else if (node.type === 'emphasis') {
      runs.push(...inlineRuns(node.children, context, { ...style, italics: true }, width))
    } else if (node.type === 'delete') {
      runs.push(...inlineRuns(node.children, context, { ...style, strike: true }, width))
    } else if (node.type === 'link' && node.url) {
      runs.push(new ExternalHyperlink({ link: node.url, children: inlineRuns(node.children, context, { ...style, style: 'Hyperlink' }, width) }))
    } else if (node.type === 'image') {
      const media = localImage(node.url, context)
      runs.push(media ? imageRun(media, node.alt ?? '', width, 200) : altRun(node.alt))
    } else {
      runs.push(...inlineRuns(node.children, context, style, width))
    }
  }
  return runs
}

function singleImage(nodes: MarkdownNode[] | undefined): MarkdownNode | undefined {
  return nodes?.length === 1 && nodes[0].type === 'image' ? nodes[0] : undefined
}

function imageBlock(node: MarkdownNode, context: ExportContext): Paragraph[] {
  const media = localImage(node.url, context)
  return media
    ? figure(media, node.alt ?? '', PAGE_IMAGE_WIDTH, 640)
    : [bodyParagraph({ children: [altRun(node.alt)] })]
}

function diagramBlock(node: MarkdownNode, context: ExportContext): Paragraph[] | null {
  const diagrams = context.input.diagrams
  if (!isMermaid(node) || !diagrams || !node.value || !Object.hasOwn(diagrams, node.value)) return null
  const media = mediaFromImage(nativeImage.createFromDataURL(diagrams[node.value]))
  return media ? figure(media, '', PAGE_IMAGE_WIDTH, WORD_DIAGRAM_HEIGHT) : null
}

// Estimate Word's widths in twips. East Asian glyphs take one em, with an
// average half em for Latin text. The same allocator as PDF handles the budget.
function estimatedTextWidth(text: string): number {
  let longest = 0
  for (const line of text.split('\n')) {
    let width = 0
    for (const char of line) width += /[^\u0000-\u024f]/.test(char) ? 1 : 0.53
    longest = Math.max(longest, width)
  }
  return longest * CELL_SIZE * 10
}

function tableWidths(rows: MarkdownNode[][]): number[] {
  const headers = rows[0]
  const em = CELL_SIZE * 10
  const widths = distributeWidth(headers.map((header, column) => {
    const title = estimatedTextWidth(textContent(header))
    const titleTarget = title > 6 * em ? title / 2 : title
    const body = rows.slice(1).map((row) => {
      const cell = row[column]
      return singleImage(cell.children) ? 16 * em : estimatedTextWidth(textContent(cell))
    }).sort((a, b) => a - b)
    const typical = body[Math.floor((body.length - 1) * 0.75)] ?? 0
    return {
      minimum: 2 * CELL_PADDING + Math.max(Math.min(titleTarget, 5 * em), Math.min(typical, 4 * em)),
      preferred: 2 * CELL_PADDING + Math.max(titleTarget, typical),
    }
  }), WORD_CONTENT_WIDTH)

  let used = 0
  return widths.map((width, index) => {
    const rounded = index === widths.length - 1 ? WORD_CONTENT_WIDTH - used : Math.floor(width)
    used += rounded
    return rounded
  })
}

function tableForNode(node: MarkdownNode, context: ExportContext): Table | null {
  const rows = node.children?.map((row) => row.children ?? []) ?? []
  if (!rows.length || !rows[0].length) return null
  const columns = rows[0].length
  const grid = rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? { type: 'tableCell' }))
  const widths = tableWidths(grid)
  const gallery = grid[0].every((cell) => !(cell.children?.length))
    && grid.slice(1).some((row) => row.some((cell) => singleImage(cell.children)))
  const border = { style: 'single' as const, size: 4, color: context.theme.border }

  return new Table({
    width: { size: WORD_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.CENTER,
    margins: { top: 94, bottom: 94, left: CELL_PADDING, right: CELL_PADDING },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: grid.slice(gallery ? 1 : 0).map((row, index) => {
      const header = index === 0 && !gallery
      return new TableRow({
        tableHeader: header || undefined,
        cantSplit: true,
        children: row.map((cell, column) => {
          const width = Math.max(1, Math.floor((widths[column] - 2 * CELL_PADDING) / WORD_TWIPS_PER_PIXEL))
          const image = singleImage(cell.children)
          const media = image && localImage(image.url, context)
          const alignment = node.align?.[column] ?? undefined
          const children = media && image
            ? figure(media, image.alt ?? '', width, 260, true)
            : [new Paragraph({
                alignment,
                style: 'ColaMDTableText',
                children: inlineRuns(cell.children, context, header ? { bold: true } : {}, width),
              })]
          return new TableCell({
            width: { size: widths[column], type: WidthType.DXA },
            shading: header ? { fill: context.theme.tableHeader } : undefined,
            children,
          })
        }),
      })
    }),
  })
}

function containsTable(node: MarkdownNode): boolean {
  return node.type === 'table' || Boolean(node.children?.some(containsTable))
}

function blockNodes(nodes: MarkdownNode[] | undefined, context: ExportContext, listDepth = 0): Array<Paragraph | Table> {
  const output: Array<Paragraph | Table> = []
  const { theme } = context
  const blocks = nodes ?? []
  for (const [index, node] of blocks.entries()) {
    if (node.type === 'heading') {
      const depth = Math.max(0, Math.min(5, (node.depth ?? 1) - 1))
      output.push(new Paragraph({ heading: HEADINGS[depth], children: inlineRuns(node.children, context) }))
    } else if (node.type === 'paragraph') {
      const image = singleImage(node.children)
      if (image) {
        output.push(...imageBlock(image, context))
        continue
      }
      const next = blocks[index + 1]
      const introducesDiagram = next && isMermaid(next) && textContent(node).length <= 280
      output.push(bodyParagraph({
        children: inlineRuns(node.children, context),
        keepNext: introducesDiagram || undefined,
        keepLines: introducesDiagram || undefined,
      }))
    } else if (node.type === 'image') {
      output.push(...imageBlock(node, context))
    } else if (node.type === 'blockquote') {
      if (node.children?.some(containsTable)) {
        for (const child of node.children) {
          if (containsTable(child)) output.push(...blockNodes([child], context, listDepth))
          else output.push(...blockNodes([{ ...node, children: [child] }], context, listDepth))
        }
        continue
      }
      const quoteRuns: ParagraphChild[] = []
      for (const child of (node.children ?? []).filter((c) => c.type !== 'blockquote')) {
        if (quoteRuns.length > 0) quoteRuns.push(new TextRun({ break: 1 }))
        quoteRuns.push(...inlineRuns(child.children ?? [], context))
      }
      output.push(bodyParagraph({
        children: quoteRuns.length > 0 ? quoteRuns : [new TextRun({ text: textContent(node) })],
        indent: { left: 300 },
        spacing: { before: 120, after: 180 },
        border: { left: { color: theme.quoteBorder, space: 9, style: 'single', size: 20 } },
      }))
    } else if (node.type === 'code') {
      const diagram = diagramBlock(node, context)
      if (diagram) {
        output.push(...diagram)
        continue
      }
      const border = { color: theme.border, space: 5, style: 'single' as const, size: 4 }
      output.push(bodyParagraph({
        children: codeRuns(node.value ?? ''),
        alignment: AlignmentType.LEFT,
        shading: { fill: theme.codeBackground },
        spacing: { before: 145, after: 155, line: 270 },
        border: { top: border, bottom: border, left: border, right: border },
      }))
    } else if (node.type === 'list') {
      const start = node.start ?? 1
      for (const [index, item] of (node.children ?? []).entries()) {
        const first = item.children?.[0]?.type === 'paragraph' ? item.children[0] : undefined
        const prefix = node.ordered ? `${start + index}. ` : '• '
        output.push(bodyParagraph({
          children: [new TextRun({ text: prefix }), ...inlineRuns(first?.children, context)],
          indent: { left: 360 + listDepth * 360, hanging: 240 },
          spacing: { after: 70 },
        }))
        output.push(...blockNodes(item.children?.filter((child) => child !== first), context, listDepth + 1))
      }
    } else if (node.type === 'table') {
      const table = tableForNode(node, context)
      if (table) {
        // Word treats adjacent tables as one and repeats the wrong header.
        if (output.at(-1) instanceof Table) {
          output.push(new Paragraph({ spacing: { before: 0, after: 100, line: 40, lineRule: 'exact' } }))
        }
        output.push(table)
      }
    } else if (node.type === 'thematicBreak') {
      output.push(new Paragraph({ border: { bottom: { color: theme.border, space: 1, style: 'single', size: 6 } } }))
    } else if (node.type === 'html') {
      output.push(bodyParagraph({ children: [new TextRun({ text: node.value ?? '' })] }))
    } else if (node.type === 'footnoteDefinition') {
      output.push(bodyParagraph({ children: [new TextRun({ text: textContent(node), size: 18, color: '5B636D' })] }))
    } else {
      output.push(...blockNodes(node.children, context, listDepth))
    }
  }
  return output
}

export async function markdownToDocx(input: DocxExportInput): Promise<Buffer> {
  const tree = parseWordMarkdown(input.content)
  const theme = readTheme(input.theme)
  const { width, height, margin } = WORD_PAGE
  const document = new Document({
    creator: 'ColaMD',
    title: input.sourcePath ? basename(input.sourcePath, extname(input.sourcePath)) : 'Untitled',
    styles: documentStyles(theme, input.fonts),
    sections: [{
      properties: { page: { size: { width, height }, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
      children: blockNodes(tree.children, { input, theme, images: new Map() }),
    }],
  })
  return Packer.toBuffer(document)
}
