export interface WordTextMetrics {
  size: number
  lineHeight: number
  rule?: string
}

export interface WordFontFamilies {
  latin?: string
  eastAsia?: string
  headingEastAsia?: string
}

export interface WordTheme {
  font: 'sans' | 'serif' | 'mono'
  fontStack?: string
  body?: WordTextMetrics
  headings?: WordTextMetrics[]
  text: string
  accent: string
  border: string
  quoteBorder: string
  tableHeader: string
  codeBackground: string
}

export interface WordExportPayload {
  content: string
  sourcePath: string | null
  diagrams: Record<string, string>
  theme: WordTheme
}

export const DEFAULT_WORD_THEME: WordTheme = {
  font: 'sans',
  text: '24292F',
  accent: '0969DA',
  border: 'DCE1E6',
  quoteBorder: 'D0D7DE',
  tableHeader: 'F0F3F6',
  codeBackground: 'F6F8FA',
}

export const WORD_PAGE = { width: 11906, height: 16838, margin: 1134 }
export const WORD_CONTENT_WIDTH = WORD_PAGE.width - WORD_PAGE.margin * 2
export const WORD_TWIPS_PER_PIXEL = 15
export const WORD_DIAGRAM_HEIGHT = 720
