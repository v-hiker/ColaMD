#!/usr/bin/env node
// Word 导出的验收：把产物解包，量 XML 结构。
//
// 为什么需要它：#202 报的三个毛病（字体写死 Menlo 导致 Windows 上代码块变符号乱码、
// 多行代码没有真换行、代码段落继承两端对齐把键值顶到两边）都是 **Windows 才能看见** 的，
// 在 mac 上导出一次看起来完全正常。所以判据只能落到 document.xml 上：
// 字体槽位里有平台等宽字体和中文回退、每行代码之间有一个 <w:br/>、代码段落显式左对齐。
//
// 用法: npm run verify:docx
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const APP = fileURLToPath(new URL('..', import.meta.url))
const TEMP = resolve(tmpdir())
const WORK = mkdtempSync(join(TEMP, 'colamd-verify-docx-'))
process.on('exit', () => {
  if (dirname(resolve(WORK)) === TEMP) rmSync(WORK, { recursive: true, force: true })
})

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name} ${detail}`)
  }
}

// OOXML checks run in Node. Supply a small PNG for the NativeImage calls.
const stub = join(WORK, 'electron-stub.cjs')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9ncAAAAASUVORK5CYII='
writeFileSync(stub, `const pixel = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from('${PNG}', 'base64') }
module.exports = { nativeImage: { createFromDataURL: () => pixel } }\n`)
const bundle = join(WORK, 'docx-export.cjs')
await build({ entryPoints: [join(APP, 'src/main/docx-export.ts')], bundle: true, platform: 'node',
  format: 'cjs', alias: { electron: stub }, outfile: bundle, logLevel: 'error' })

const CODE = ['{', '  "key": "值",', '', '  "nested": {', '    "a": 1', '  }', '}'].join('\n')
const DIAGRAM = 'flowchart LR\n  A --> B'
const dataURL = `data:image/png;base64,${PNG}`
const fixture = [
  '# 导出验证',
  '',
  '正文里有 `行内代码` 和中文。',
  '',
  '```json',
  CODE,
  '```',
  '',
  '> 引用第一段。讲透**「任务一」**与**「任务二」**在**工程**上的要求。',
  '>',
  '> 引用第二段',
  '',
  '| 项目 | 比较说明 |',
  '| --- | --- |',
  '| 序号 | 描述较长的情况需要把更多纸面宽度留给说明列。 |',
  '',
  '| | |',
  '| --- | --- |',
  `| ![表格图片甲](${dataURL}) | ![表格图片乙](${dataURL}) |`,
  '',
  '~~~mermaid',
  DIAGRAM,
  '~~~',
  '',
].join('\n')

const require_ = createRequire(import.meta.url)
const { markdownToDocx } = require_(bundle)
const docxPath = join(WORK, 'out.docx')
writeFileSync(docxPath, await markdownToDocx({
  content: fixture,
  sourcePath: null,
  diagrams: { [DIAGRAM]: dataURL },
  theme: { font: 'serif', accent: '654383', tableHeader: 'EEE8F2', quoteBorder: 'D0D7DE' },
}))

function readPart(part, file = docxPath) {
  const [command, option] = process.platform === 'win32' ? ['tar', '-xOf'] : ['unzip', '-p']
  return execFileSync(command, [option, file, part]).toString('utf8')
}
const xml = readPart('word/document.xml')
const styles = readPart('word/styles.xml')

// 1. 字体：代码不能写死 macOS 字体，四个槽位里要有平台等宽字体 + 中文回退
const fontSlots = [...xml.matchAll(/<w:rFonts ([^/>]*)\/>/g)].map((m) => m[1])
const codeSlots = fontSlots.filter((slot) => /(Menlo|Consolas|DejaVu Sans Mono)/.test(slot))
check('代码字体不是写死的 Menlo', codeSlots.length > 0 && codeSlots.every((slot) => /w:eastAsia="/.test(slot)),
  `代码 run 的字体槽位=${JSON.stringify(codeSlots.slice(0, 2))}`)
check('代码字体按平台选（macOS 是 Menlo）', codeSlots.every((slot) => process.platform !== 'darwin' || /w:ascii="Menlo"/.test(slot)))

// 2. 换行：每行代码之间要有一个 <w:br/>，不能只有一个塞着 \n 的 <w:t>
const breaks = (xml.match(/<w:br\/>/g) ?? []).length
const codeLines = CODE.split('\n').length
const quoteBreaks = 1
check('代码块每行之间是 <w:br/>，不是自动折行', breaks === codeLines - 1 + quoteBreaks,
  `<w:br/> ${breaks} 个，期望 ${codeLines - 1 + quoteBreaks}`)
check('代码里没有塞进 <w:t> 的换行符', !/<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/.test(xml))

// 3. 对齐与拼写检查：代码段落显式左对齐，变量名不带红波浪线
check('代码段落显式左对齐', /w:jc w:val="left"/.test(xml))
check('代码 run 关掉拼写检查', (xml.match(/<w:noProof\/>/g) ?? []).length >= codeLines)
check('代码里的空格保留（xml:space）', /<w:t xml:space="preserve">\s{2}&quot;key&quot;/.test(xml))

// 4. 内容不丢
check('中文注释保留', xml.includes('值'))
check('引用两段都在，且没有挤成一段', xml.includes('引用第一段') && xml.includes('引用第二段'))
check('标题保留', xml.includes('导出验证'))

const quote = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].find(([paragraph]) => paragraph.includes('引用第一段'))?.[0] ?? ''
const bold = [...quote.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].filter(([, run]) => /<w:b(?:\s|\/>)/.test(run))
check('中文引号前后的粗体与编辑器一致', bold.length === 3
  && ['「任务一」', '「任务二」', '工程'].every((value) => bold.some(([, run]) => run.includes(value)))
  && !quote.includes('**'))
check('引用使用常规字形与主题竖线', !/<w:i(?:\s|\/>)/.test(quote) && /w:color="D0D7DE"/.test(quote))

check('正文和标题使用主题字体与链接颜色', /w:eastAsia="(?:SimSun|Songti SC|Noto Serif CJK SC)"/.test(styles)
  && /w:color w:val="654383"/.test(styles) && /w:pStyle w:val="Heading1"/.test(xml))
check('表格有固定列宽、主题表头和原生重复标题行', /w:tblLayout w:type="fixed"/.test(xml)
  && /w:fill="EEE8F2"/.test(xml) && (xml.match(/<w:tblHeader\b/g) ?? []).length === 1)
check('相邻表格之间有分隔段落', /<\/w:tbl><w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p><w:tbl>/.test(xml))
check('表格图片及 Mermaid 为原生内嵌图，保留图片题注', (xml.match(/<w:drawing>/g) ?? []).length === 3
  && xml.includes('表格图片甲') && !xml.includes('flowchart LR'))

// 5. 列表项以表格或代码开头时，后面的段落不能被提到它们前面
const listFixture = [
  '- | 表头甲 | 表头乙 |',
  '  |---|---|',
  '  | 格一 | 格二 |',
  '',
  '  表格后的段落',
  '- ```',
  '  代码行',
  '  ```',
  '',
  '  代码后的段落',
  '- 普通项文字',
  '',
].join('\n')
const listPath = join(WORK, 'list.docx')
writeFileSync(listPath, await markdownToDocx({ content: listFixture, sourcePath: null }))
const listXml = readPart('word/document.xml', listPath)
const at = (text) => listXml.indexOf(text)
check('列表项里表格在后续段落之前', at('表头甲') >= 0 && at('表头甲') < at('表格后的段落'), `表格 ${at('表头甲')} 段落 ${at('表格后的段落')}`)
check('列表项里代码在后续段落之前', at('代码行') >= 0 && at('代码行') < at('代码后的段落'), `代码 ${at('代码行')} 段落 ${at('代码后的段落')}`)
check('以段落开头的项仍和符号同一行', /• <\/w:t>(?:(?!<\/w:p>).)*普通项文字/s.test(listXml))

console.log(`\n${passed} passed / ${failed} failed`)
if (failed > 0) process.exitCode = 1
