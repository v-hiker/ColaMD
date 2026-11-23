#!/usr/bin/env node
// PDF 导出的真机验证：驱动真实的导出通道，检查纸上是不是**整篇**。
//
// 为什么需要它：编辑器只为视口内的行建 DOM（长文档在屏幕上只有十几行是真的元素），
// 而 PDF 打印的就是这个窗口。少了「导出前把整篇渲染出来」这一步，长文档导出的只有
// 当前视口那一屏（2026-09-26 报的「长文档只渲染了前面」）。页数是最直接的判据：
// 一屏的内容只够一两页，整篇会摊成很多页。
//
// 用法: npm run verify:export-pdf（先 npm run build）
// 窗口放在屏幕外，测试不占用屏幕。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertBuildFresh } from './build-freshness.mjs'
import { stopVerifyApp, verifyWorkdir } from './verify-workdir.mjs'

const APP = fileURLToPath(new URL('..', import.meta.url))
const electron = createRequire(import.meta.url)('electron')
assertBuildFresh()
const { dir: WORK, udd } = verifyWorkdir('export-pdf')

/** 三百行正文：屏幕上一屏只装得下二十来行，所以「只有视口」和「整篇」的页数差得很远。 */
const ROWS = 300
/** 一屏内容最多两页；整篇 300 行按 A4 排下来不会少于这个数。 */
const MIN_PAGES = 5

function fixture() {
  const lines = [
    '# 导出验证', '', '## 开头章节', '',
    '| 对比维度 | 方案一 | 方案二 | 方案三 |',
    '| --- | --- | --- | --- |',
    '| 图纸体量 | 单张大图拆为多个子图，计算之前进一步核对有效楼层 | 按工程楼层分别核对每份图纸的编号和楼层 | 分图统计后对照详图判断有无额外构件 |',
    '| 构件规模 | 汇总不同楼层的构件数量，逐个复核钢梁钢柱 | 单独核对构件表与图纸中标出的构件数量 | 给出混凝土梁和墙柱的分项计数与总数 |',
    '', '```mermaid', 'flowchart LR', '  A[图纸] --> B[构件]', '```', '',
  ]
  for (let i = 1; i <= ROWS; i++) {
    if (i === 150) lines.push('## 后段章节', '')
    lines.push(`第 ${i} 行：这一段用来把文档撑长，检查导出的 PDF 里是不是整篇都在。`)
    lines.push('')
  }
  return lines.join('\n')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const msgId = ++id
          pending.set(msgId, { res, rej })
          ws.send(JSON.stringify({ id: msgId, method, params }))
        })
      },
      close: () => ws.close()
    }))
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    })
    ws.addEventListener('error', () => reject(new Error(`连接不上 ${url}`)))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitTarget(port, predicate, ms = 30000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const hit = list.find(predicate)
      if (hit) return hit
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('等不到调试目标')
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', {
    expression, includeCommandLineAPI: true, returnByValue: true, awaitPromise: true
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400))
    return result.result?.value
  })
}

/** PDF 里的页数。Chromium 把页对象写成明文的 /Type /Page，不压缩。 */
function pageCount(file) {
  const raw = readFileSync(file).toString('latin1')
  const pages = (raw.match(/\/Type\s*\/Page(?![s])/g) ?? []).length
  const hasOutline = /\/Outlines\s+\d+\s+\d+\s+R/.test(raw)
  return { pages, bytes: raw.length, hasOutline }
}

async function main() {
  mkdirSync(WORK, { recursive: true })
  const source = join(WORK, 'long.md')
  const out = join(WORK, 'long.pdf')
  writeFileSync(source, fixture(), 'utf8')

  const port = 9900 + Math.floor(Math.random() * 60)
  const inspect = port + 1000
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, ['scripts/offscreen-window.cjs', source, `--user-data-dir=${udd}`,
    '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`, `--inspect=${inspect}`
  ], { cwd: APP, env, stdio: 'ignore' })

  try {
    const page = await waitTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url))
    const mainTarget = await waitTarget(inspect, (t) => t.type === 'node')
    const renderer = await connect(page.webSocketDebuggerUrl)
    await renderer.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const main = await connect(mainTarget.webSocketDebuggerUrl)

    // 测试不许占用屏幕：连上就藏好，并且别让导出流程把窗口叫回来
    await evaluate(main, `(() => {
      const { BrowserWindow, dialog } = require('electron')
      BrowserWindow.prototype.show = function () {}
      BrowserWindow.prototype.focus = function () {}
      BrowserWindow.getAllWindows().forEach((win) => { win.setPosition(-4000, -4000) })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} })
      globalThis.__exportError = null
      dialog.showMessageBox = async (win, options) => { globalThis.__exportError = options; return { response: 0 } }
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const printToPDF = contents.printToPDF.bind(contents)
      contents.printToPDF = async (options) => {
        globalThis.__printLayout = await contents.executeJavaScript('({ columns: [...document.querySelectorAll(".cm-pdf-copy table col")].map(col => parseFloat(col.style.width)), diagram: !!document.querySelector(".cm-pdf-copy .cm-md-mermaid svg") })')
        return printToPDF(options)
      }
      return true
    })()`)

    for (let i = 0; i < 80; i++) {
      if (String(await evaluate(renderer, 'document.title')).includes('long')) break
      await sleep(250)
    }
    // 文档要先渲染出来：等编辑器里出现正文行
    for (let i = 0; i < 80; i++) {
      const lines = await evaluate(renderer, `document.querySelectorAll('#editor .cm-line').length`)
      if (Number(lines) > 5) break
      await sleep(250)
    }

    if (!await evaluate(renderer, 'window.electronAPI.exportPDF()') || !existsSync(out)) {
      throw new Error('PDF 导出没有生成文件')
    }
    const { columns, diagram } = await evaluate(main, 'globalThis.__printLayout')
    if (columns.length !== 4 || columns[0] >= 25 || columns.slice(1).some((width) => width < 20 || width > 35)) {
      throw new Error(`PDF 的三个对比列宽分配失衡：${columns.map((width) => Math.round(width)).join('% / ')}%`)
    }
    if (!diagram) throw new Error('PDF 的打印内容缺少 Mermaid SVG')
    if (await evaluate(renderer, 'Boolean(document.querySelector(".cm-pdf-copy"))')) {
      throw new Error('PDF 打印副本未清理')
    }
    console.log('✓ PDF 表格按纸面分配列宽，包含 Mermaid 图，导出后已还原界面')

    renderer.close()
    main.close()

    const { pages, bytes, hasOutline } = pageCount(out)
    console.log(`PDF ${bytes} 字节，页数 ${pages}`)
    if (pages < MIN_PAGES) {
      console.log(`✗ 只导出 ${pages} 页，${ROWS} 行的文档不可能只有这么点：整篇没有渲染出来`)
      process.exitCode = 1
      return
    }
    console.log(`✓ ${ROWS} 行的文档导出成 ${pages} 页，整篇都在纸上`)
    if (!hasOutline) throw new Error('导出的 PDF 缺少原生书签')
    console.log('✓ 导出的 PDF 包含原生书签')
  } finally {
    if (child.exitCode === null) child.kill()
    stopVerifyApp(udd)
    await sleep(300)
  }
}

main().catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exitCode = 1
})
