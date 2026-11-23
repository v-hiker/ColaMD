// 渲染/源码切换：选区不丢、光标仍可见，位置不会随两种排版的高度差跳走。
// 先 npm run build，再 npm run verify:source-mode。
// --out /path/to/reports --label after 可保留逐项结果；默认不留测试文件。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const root = resolve(option('--root', join(dirname(fileURLToPath(import.meta.url)), '..')))
const out = option('--out', null) ? resolve(option('--out')) : null
const label = option('--label', 'result')
assert(/^[a-zA-Z0-9_-]+$/.test(label), 'label只能含字母、数字、下划线及连字符')
if (out) mkdirSync(out, { recursive: true })

const paragraphs = (count, prefix) => Array.from({ length: count }, (_, i) =>
  `${prefix}${String(i).padStart(3, '0')}：普通正文混合 **加粗**、[可见链接](https://example.com/a/long/hidden/path?x=1) 和中文。${'正文内容和 English words 连续排列，观察切换后的实际光标位置。'.repeat(4)}`).join('\n\n')
const tableRows = Array.from({ length: 1500 }, (_, i) => `| 项目${String(i + 1).padStart(4, '0')} | 第${i + 1}行目标内容 | ${i % 3 ? '短' : '较长说明，自动换行后渲染与源码有不同的高度。'} | ${i * 7} | [链接](https://example.com/${i}) | 完成 |`).join('\n')
const fixture = '# 模式切换视口独立夹具\n\n' + paragraphs(35, '前段') +
  '\n\n## 标题目标：切换时应保留附近的光标\n\n' + paragraphs(12, '中段') +
  '\n\n| 名称 | 说明 |\n|---|---|\n| 普通表格 | **格内目标文字**和[链接标签](https://example.com/hidden) |\n| 第二行 | 内容 |\n\n' +
  paragraphs(12, '表前') + '\n\n| 项目 | 说明 | 备注 | 数值 | 链接 | 状态 |\n|---|---|---|---:|---|---|\n' + tableRows +
  '\n\n长软换行起点：' + '中文连续软换行 word emoji😀 é TAB\t'.repeat(180) + '长软换行终点。\n\n' +
  paragraphs(45, '后段') + '\n'
const fixtureFile = out ? join(out, 'viewport-fixture.md') : null
if (fixtureFile) writeFileSync(fixtureFile, fixture)
const at = (needle, offset = 0) => { const p = fixture.indexOf(needle); assert(p >= 0, needle); return p + offset }
const caret = (name, needle, offset = 0) => ({ name, anchor: at(needle, offset), head: at(needle, offset) })
const scenarios = [
  caret('普通正文', '中段004', 10),
  caret('标题', '标题目标', 8),
  caret('普通表格', '格内目标文字', 3),
  caret('长表格中段', '第746行目标内容', 5),
  caret('长软换行', '长软换行起点', 1900),
  { name: '反向选择', anchor: at('后段010', 12), head: at('后段010', 6) },
  { name: '正向选择', anchor: at('中段008', 6), head: at('中段008', 12) },
  caret('UTF16 emoji后', 'emoji😀', 'emoji😀'.length),
  { name: 'UTF16 组合字符反向选择', anchor: at('emoji😀 é', 'emoji😀 é'.length), head: at('emoji😀', 'emoji😀'.length) },
]
if (args.includes('--fixture-only')) { console.log(JSON.stringify({ fixtureFile, bytes: Buffer.byteLength(fixture), scenarios }, null, 2)); process.exit(0) }

await import(pathToFileURL(join(root, 'scripts/build-freshness.mjs')).href).then(m => m.assertBuildFresh())
const { verifyWorkdir, stopVerifyApp } = await import(pathToFileURL(join(root, 'scripts/verify-workdir.mjs')).href)
const require = createRequire(join(root, 'package.json'))
const { dir: runtime, udd } = verifyWorkdir('source-mode')
const file = join(runtime, 'fixture.md')
writeFileSync(file, fixture)
const originalMtime = statSync(file).mtimeMs
const port = 20600 + Math.floor(Math.random() * 200)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), ['scripts/offscreen-window.cjs', file, '--user-data-dir=' + udd, '--remote-debugging-port=' + port,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
let launchOutput = '', ws, exitCode = 1
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
child.stdout.on('data', x => { launchOutput += x.toString() }); child.stderr.on('data', x => { launchOutput += x.toString() })
const results = [], failures = [], errors = []
const check = (name, ok, detail) => { results.push({ name, passed: !!ok, detail }); if (!ok) failures.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + JSON.stringify(detail)}`) }
const transcript = { root, label, fixtureFile, fixtureBytes: Buffer.byteLength(fixture), results, failures, errors, cases: [] }

try {
  let page
  for (let i = 0; i < 180 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page') } catch {}
    if (!page) await pause(100)
  }
  assert(page, '未启动测试页面：' + JSON.stringify({ exitCode: child.exitCode, launchOutput }))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('调试页面已关闭')) }; pending.clear() })
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description ?? a.value))
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP请求超时：' + method)) }, 30000)
    pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value
  }
  await send('Runtime.enable')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false })
  let ready = false
  for (let i = 0; i < 200 && !ready; i++) { ready = await evaluate(`document.querySelector('#editor .cm-content')?.cmTile?.root?.view?.state.doc.toString()===${JSON.stringify(fixture)}`); if (!ready) await pause(100) }
  assert(ready, '编辑器未就绪')
  await evaluate(`window.v = document.querySelector('#editor .cm-content').cmTile.root.view; document.fonts.ready`)
  transcript.frameCadence = await evaluate(`(async()=>{const times=[];for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(t=>{times.push(t);resolve()}));return{visibility:document.visibilityState,deltas:times.slice(1).map((t,i)=>t-times[i])}})()`)

  // 与产品实现独立：在测试页复制实际textarea排版，直接量目标字符的Range。
  // 不使用产品source-line helper、逻辑行*行高、滚动比例，也不改变textarea内容。
  await evaluate(`window.viewportProbe = (() => {
    const view = () => document.querySelector('#editor .cm-content').cmTile.root.view
    const source = () => document.getElementById('source-editor')
    function sourceCarets(positions) {
      const el = source(), computed = getComputedStyle(el), mirror = document.createElement('div')
      for (const prop of ['font-family','font-size','font-weight','font-style','font-variant','font-stretch','line-height','letter-spacing','word-spacing','text-align','text-indent','text-transform','tab-size','word-break','overflow-wrap','direction','padding-top','padding-right','padding-bottom','padding-left']) mirror.style.setProperty(prop,computed.getPropertyValue(prop))
      Object.assign(mirror.style,{position:'fixed',left:'0',top:'0',width:el.clientWidth+'px',height:'auto',minHeight:'0',maxHeight:'none',margin:'0',border:'0',boxSizing:'border-box',whiteSpace:el.wrap==='off'?'pre':'pre-wrap',visibility:'hidden',pointerEvents:'none',overflow:'visible'})
      // 单一文本节点保留浏览器原生分词和换行；末尾sentinel让空文档/最后空行有矩形。
      const text = document.createTextNode(el.value+'\\u2060'); mirror.appendChild(text); document.body.appendChild(mirror)
      try {
        const box=el.getBoundingClientRect(),m=mirror.getBoundingClientRect()
        return positions.map(position=>{
          const range = document.createRange(), p = Math.max(0,Math.min(position,el.value.length))
          range.setStart(text,p);range.setEnd(text,p+1)
          const r=range.getBoundingClientRect()
          return {top:box.top+el.clientTop+r.top-m.top-el.scrollTop,bottom:box.top+el.clientTop+r.bottom-m.top-el.scrollTop,left:box.left+el.clientLeft+r.left-m.left-el.scrollLeft,mirrorHeight:mirror.scrollHeight,scrollHeight:el.scrollHeight}
        })
      }finally{mirror.remove()}
    }
    const sourceCaret = position => sourceCarets([position])[0]
    function measure(mode, position) {
      const v=view(),el=mode==='source'?source():v.scrollDOM,box=el.getBoundingClientRect()
      const selection=mode==='source'?{anchor:source().selectionDirection==='backward'?source().selectionEnd:source().selectionStart,head:source().selectionDirection==='backward'?source().selectionStart:source().selectionEnd}: {anchor:v.state.selection.main.anchor,head:v.state.selection.main.head}
      const c=mode==='source'?sourceCaret(selection.head):v.coordsAtPos(selection.head)
      const expected=position===selection.head?c:mode==='source'?sourceCaret(position):v.coordsAtPos(position)
      const top=box.top+el.clientTop,bottom=top+el.clientHeight
      let nativeHead=null
      const native=getSelection()
      if(mode==='render'&&native?.focusNode&&v.contentDOM.contains(native.focusNode))try{nativeHead=v.posAtDOM(native.focusNode,native.focusOffset)}catch{}
      return {mode,selection,nativeHead,activeElement:document.activeElement?.id||document.activeElement?.className||null,expectedPosition:position,expectedCaret:expected?{top:expected.top,bottom:expected.bottom,left:expected.left}:null,focused:mode==='source'?document.activeElement===source():v.hasFocus,scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,viewport:{top,bottom,height:el.clientHeight,width:el.clientWidth},caret:c?{top:c.top,bottom:c.bottom,left:c.left}:null,relativeY:c?((c.top+c.bottom)/2-top)/el.clientHeight:null,visible:!!c&&c.top>=top-1&&c.bottom<=bottom+1,lineHeight:parseFloat(getComputedStyle(el).lineHeight)||24,mirrorHeight:c?.mirrorHeight??null}
    }
    async function settle(mode,position) {
      let last='',stable=0,result
      for(let i=0;i<150;i++) {
        await new Promise(requestAnimationFrame)
        result=measure(mode,position)
        const current=JSON.stringify([result.scrollTop,result.scrollHeight,result.caret,result.viewport])
        if(current===last)stable++;else stable=0
        if(stable>=4)return result
        last=current
      }
      throw new Error('几何未稳定：'+JSON.stringify(result))
    }
    async function place(mode,anchor,head) {
      if(mode==='source') {source().focus({preventScroll:true});source().setSelectionRange(Math.min(anchor,head),Math.max(anchor,head),head<anchor?'backward':'forward')}
      else {view().dispatch({selection:{anchor,head},scrollIntoView:true});view().focus()}
      await settle(mode,head)
      for(let i=0;i<3;i++) {const m=measure(mode,head);if(!m.caret)throw new Error('准备阶段找不到光标');const el=mode==='source'?source():view().scrollDOM;el.scrollTop+=(m.caret.top+m.caret.bottom)/2-m.viewport.top-m.viewport.height*0.37;await settle(mode,head)}
      return measure(mode,head)
    }
    return {measure,settle,place,sourceCarets}
  })()`)
  const mode = () => evaluate(`document.getElementById('source-editor').classList.contains('visible')?'source':'render'`)
  const toggle = async (target, head) => {
    await evaluate(`document.getElementById('source-toggle-btn').click()`)
    assert(await mode() === target, '按钮没有切换到' + target)
    return evaluate(`viewportProbe.settle(${JSON.stringify(target)},${head})`)
  }
  const waitFor = async (expression, message) => {
    const ready = await evaluate(`(async()=>{for(let i=0;i<300;i++){if(${expression})return true;await new Promise(requestAnimationFrame)}return false})()`)
    assert(ready, message)
  }
  const openFixture = async (path, text) => {
    await evaluate(`window.electronAPI.openSibling(${JSON.stringify(path)})`)
    await waitFor(`!document.getElementById('source-editor').classList.contains('visible')&&v.state.doc.toString()===${JSON.stringify(text)}`, '未打开独立夹具')
    await evaluate('viewportProbe.settle("render",v.state.selection.main.head)')
  }
  check('实际文件原文已加载', await evaluate('v.state.doc.toString()') === fixture)
  const runScenario = async (scenario, expected = fixture, nearby = true) => {
    const { name, anchor, head } = scenario
    const item = { name, anchor, head }; transcript.cases.push(item)
    if (await mode() === 'source') await toggle('render', head)
    item.renderBefore = await evaluate(`viewportProbe.place('render',${anchor},${head})`)
    check(name + '准备时渲染光标可见', item.renderBefore.visible, item.renderBefore)
    item.sourceAfter = await toggle('source', head)
    check(name + '渲染→源码原文不变', await evaluate(`document.getElementById('source-editor').value`) === expected)
    check(name + '渲染→源码选区及方向不变', item.sourceAfter.selection.anchor === anchor && item.sourceAfter.selection.head === head, item.sourceAfter.selection)
    check(name + '渲染→源码光标可见且有焦点', item.sourceAfter.visible && item.sourceAfter.focused, item.sourceAfter)
    const sourceDistance = Math.abs(item.sourceAfter.relativeY - item.renderBefore.relativeY) * item.sourceAfter.viewport.height
    if (nearby) check(name + '渲染→源码光标在原纵向附近', Number.isFinite(sourceDistance) && sourceDistance <= Math.max(item.sourceAfter.viewport.height * 0.12, item.sourceAfter.lineHeight * 2), { distance: sourceDistance, before: item.renderBefore.relativeY, after: item.sourceAfter.relativeY })
    check(name + '源码几何oracle覆盖真实换行高度', Math.abs(Math.max(item.sourceAfter.mirrorHeight, item.sourceAfter.viewport.height) - item.sourceAfter.scrollHeight) <= item.sourceAfter.lineHeight + 2, { mirrorHeight: item.sourceAfter.mirrorHeight, scrollHeight: item.sourceAfter.scrollHeight })

    // 独立准备反向测试，避免上一步失败导致的错误视口成为下一步基准。
    item.sourceBefore = await evaluate(`viewportProbe.place('source',${anchor},${head})`)
    check(name + '准备时源码光标可见', item.sourceBefore.visible, item.sourceBefore)
    item.renderAfter = await toggle('render', head)
    check(name + '源码→渲染原文不变', await evaluate('v.state.doc.toString()') === expected)
    check(name + '源码→渲染选区及方向不变', item.renderAfter.selection.anchor === anchor && item.renderAfter.selection.head === head, item.renderAfter.selection)
    check(name + '源码→渲染光标可见且有焦点', item.renderAfter.visible && item.renderAfter.focused, item.renderAfter)
    const renderDistance = Math.abs(item.renderAfter.relativeY - item.sourceBefore.relativeY) * item.renderAfter.viewport.height
    if (nearby) check(name + '源码→渲染光标在原纵向附近', Number.isFinite(renderDistance) && renderDistance <= Math.max(item.renderAfter.viewport.height * 0.12, item.renderAfter.lineHeight * 2), { distance: renderDistance, before: item.sourceBefore.relativeY, after: item.renderAfter.relativeY })
  }
  for (const scenario of scenarios) await runScenario(scenario)

  // 根据独立oracle实测的换行边缘选点，不假定字体、字符宽度或一个逻辑行只有一行。
  const softStart = at('长软换行起点')
  await toggle('source', softStart)
  const candidates = Array.from({ length: 130 }, (_, i) => softStart + i).filter(p => fixture.charCodeAt(p) < 0xdc00 || fixture.charCodeAt(p) > 0xdfff)
  const rects = await evaluate(`viewportProbe.sourceCarets(${JSON.stringify(candidates)})`)
  const wrap = rects.findIndex((r, i) => i > 0 && r.top - rects[i - 1].top > 10)
  assert(wrap > 0, '软换行夹具没有跨越实测换行边缘')
  await runScenario({ name: '软换行边缘前', anchor: candidates[wrap - 1], head: candidates[wrap - 1] })
  await runScenario({ name: '软换行边缘后', anchor: candidates[wrap], head: candidates[wrap] })
  check('仅切换模式不改磁盘字节或mtime', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalMtime)

  // 共同入口使用真实鼠标点击现有按钮，每个press/release是独立输入事件，不等布局。
  for (const count of [2, 3]) {
    const scenario = scenarios.find(s => s.name === '反向选择')
    if (await mode() === 'source') await toggle('render', scenario.head)
    const before = await evaluate(`viewportProbe.place('render',${scenario.anchor},${scenario.head})`)
    const box = await evaluate(`(()=>{const r=document.getElementById('source-toggle-btn').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box })
    const observed = []
    for (let i = 0; i < count; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 })
      observed.push(await mode())
    }
    const finalMode = await mode()
    const after = await evaluate(`viewportProbe.settle(${JSON.stringify(finalMode)},${scenario.head})`)
    const later = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure(${JSON.stringify(finalMode)},${scenario.head})})()`)
    transcript.cases.push({ name: `真实鼠标${count}次切换`, route: 'CDP mouse press/release', observed, before, after, later })
    const text = await evaluate(finalMode === 'source' ? `document.getElementById('source-editor').value` : 'v.state.doc.toString()')
    const routeWorks = observed.every((m, i) => m === (i % 2 ? 'render' : 'source'))
    check(`真实鼠标${count}次正确切换模式`, routeWorks, { observed })
    check(`真实鼠标${count}次保留原文及选区方向`, text === fixture && after.selection.anchor === scenario.anchor && after.selection.head === scenario.head, after)
    if (!routeWorks || text !== fixture) {
      writeFileSync(file, fixture)
      throw new Error('真实点击未完成预期，停止后续用例并恢复本轮独立磁盘夹具')
    }
    check(`真实鼠标${count}次光标仍可见`, after.visible && after.focused, after)
    check(`真实鼠标${count}次没有过期滚动`, later.visible && Math.abs(after.scrollTop - later.scrollTop) <= 1, { after, later })
  }

  // 同调用栈连续按钮调用属于强化边界，与上面的消费者键盘路径分别记录。
  for (const count of [2, 3]) {
    const scenario = scenarios.find(s => s.name === '反向选择')
    if (await mode() === 'source') await toggle('render', scenario.head)
    const before = await evaluate(`viewportProbe.place('render',${scenario.anchor},${scenario.head})`)
    await evaluate(`for(let i=0;i<${count};i++)document.getElementById('source-toggle-btn').click()`)
    const finalMode = count % 2 ? 'source' : 'render'
    assert(await mode() === finalMode, '快速切换的最终模式错误')
    const after = await evaluate(`viewportProbe.settle(${JSON.stringify(finalMode)},${scenario.head})`)
    const later = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure(${JSON.stringify(finalMode)},${scenario.head})})()`)
    transcript.cases.push({ name: `同帧${count}次切换`, before, after, later })
    check(`同帧${count}次切换保留原文及选区方向`, await evaluate(finalMode === 'source' ? `document.getElementById('source-editor').value` : 'v.state.doc.toString()') === fixture && after.selection.anchor === scenario.anchor && after.selection.head === scenario.head, after)
    check(`同帧${count}次切换的光标仍可见`, after.visible && after.focused, after)
    check(`同帧${count}次切换没有过期滚动`, later.visible && Math.abs(after.scrollTop - later.scrollTop) <= 1, { after, later })
  }

  const short = '开头😀\n\n\n\n空行后的文字 é\n\n末尾'
  for (const [name, text, position] of [
    ['文首', short, 0],
    ['空段落', short, short.indexOf('\n\n') + 2],
    ['文末', short, short.length],
    ['末尾空行', '正文😀\n\n', '正文😀\n\n'.length],
    ['空文档', '', 0],
  ]) {
    const path = join(runtime, `${name}.md`)
    writeFileSync(path, text)
    const mtime = statSync(path).mtimeMs
    await openFixture(path, text)
    await runScenario({ name, anchor: position, head: position }, text, false)
    check(name + '切换不改磁盘字节或mtime', readFileSync(path, 'utf8') === text && statSync(path).mtimeMs === mtime)
  }

  const escapedText = [
    '# 1\\.1 S\\&OP&#x20;计划 **说明** `&amp;`',
    '',
    'S\\&OP&#x20;计划 &lt;em&gt; \\&amp; &amp;#x20; &unknown;',
    '',
    '1\\. 普通编号，\\*字面星号\\*',
    '',
    '`S\\&OP &#x20;`',
    '',
    '```js',
    'const example = "\\&amp; &#x20;";',
    '```',
  ].join('\n')
  const escapedFile = join(runtime, 'markdown-escapes.md')
  writeFileSync(escapedFile, escapedText)
  const escapedMtime = statSync(escapedFile).mtimeMs
  await openFixture(escapedFile, escapedText)
  const escapedRender = await evaluate(`(() => {
    if (document.getElementById('file-panel').hidden) document.getElementById('file-toggle-btn').click()
    document.getElementById('file-panel-outline').click()
    return {
      heading: v.contentDOM.querySelector('.cm-md-atxheading1')?.textContent,
      lines: [...v.contentDOM.querySelectorAll('.cm-line')].map(line => line.textContent),
      outline: document.querySelector('#outline-list button')?.textContent,
      numberedList: !!v.contentDOM.querySelector('.cm-md-li'),
      decodedAsHTML: !!v.contentDOM.querySelector('em'),
    }
  })()`)
  const headingLabel = '1.1 S&OP 计划 说明 &amp;'
  check('标题与大纲还原转义和字符引用，保留行内代码', escapedRender.heading === headingLabel && escapedRender.outline === headingLabel, escapedRender)
  check('正文只解码一层，字符引用仍为文本',
    escapedRender.lines.includes('S&OP 计划 <em> &amp; &#x20; &unknown;') && !escapedRender.decodedAsHTML, escapedRender)
  check('转义标点显示为普通文字', escapedRender.lines.includes('1. 普通编号，*字面星号*') && !escapedRender.numberedList, escapedRender)
  check('行内代码与语言围栏显示字面文本',
    escapedRender.lines.includes('S\\&OP &#x20;') && escapedRender.lines.includes('const example = "\\&amp; &#x20;";'), escapedRender)
  await toggle('source', 0)
  check('源码保留转义且磁盘字节与mtime不变',
    await evaluate('document.getElementById("source-editor").value') === escapedText &&
      readFileSync(escapedFile, 'utf8') === escapedText && statSync(escapedFile).mtimeMs === escapedMtime)
  check('源码模式下的大纲也显示解码后的标题',
    await evaluate('document.querySelector("#outline-list button")?.textContent') === headingLabel)
  await evaluate(`document.getElementById('file-panel-files').click(); document.getElementById('file-toggle-btn').click()`)

  const compatibilityText = [
    '---', 'title: 文档属性', '---', '',
    '第一节', '======', '',
    '第二节 &amp;', '接下一行', '-------', '',
    '[打开页面](<https://example.com/read?a=1&amp;b=2> "页面") [纯文字](javascript&#58;alert%281%29)', '',
    '| S\\&OP&#x20;计划 | 内容 |', '| --- | --- |',
    '| **甲\\*乙\\* &lt;b&gt;** | `` a ` b\\|c &amp; `` |',
    '| ***嵌套强调*** <br> $x_1$ | [页面](<https://example.com/read?a=1&amp;b=2> "链接") |', '',
    '```md', '# 围栏中的文字', '看起来像标题', '-----', '```', '',
    '   ### 缩进行首标题', '',
  ].join('\n')
  const compatibilityFile = join(runtime, 'markdown-compatibility.md')
  writeFileSync(compatibilityFile, compatibilityText)
  const compatibilityMtime = statSync(compatibilityFile).mtimeMs
  await openFixture(compatibilityFile, compatibilityText)
  const compatibility = await evaluate(`(() => {
    if (document.getElementById('file-panel').hidden) document.getElementById('file-toggle-btn').click()
    document.getElementById('file-panel-outline').click()
    const content = v.contentDOM
    const table = content.querySelector('.cm-md-table-widget')
    const html = window.__colamdExportDocumentHTML()
    const exported = new DOMParser().parseFromString(html, 'text/html')
    return {
      outline: [...document.querySelectorAll('#outline-list button')].map(row => row.textContent),
      headings: [...exported.querySelectorAll('h1,h2,h3')].map(heading => [heading.tagName, heading.textContent.trim()]),
      underlines: [...content.querySelectorAll('.cm-md-heading-underline')].map(line => line.getBoundingClientRect().height),
      bodyHrefs: [...content.querySelectorAll('.cm-md-link[data-href]')].map(link => link.dataset.href),
      unsafeHref: !!exported.querySelector('a[href^="javascript:"]'),
      header: table?.querySelector('th')?.textContent,
      strong: table?.querySelector('strong')?.textContent,
      code: table?.querySelector('code')?.textContent,
      nested: table?.querySelector('em strong')?.textContent,
      math: !!table?.querySelector('.katex'),
      lineBreak: !!table?.querySelector('br'),
      tableHref: table?.querySelector('a')?.getAttribute('href'),
    }
  })()`)
  const headingLabels = ['第一节', '第二节 & 接下一行', '缩进行首标题']
  check('下划线标题进入大纲，围栏和文档属性不算标题',
    JSON.stringify(compatibility.outline) === JSON.stringify(headingLabels), compatibility)
  check('下划线在渲染中折叠，多行标题整体导出',
    JSON.stringify(compatibility.underlines) === '[0,0]' &&
    JSON.stringify(compatibility.headings) === JSON.stringify(headingLabels.map((label, index) => ['H' + (index + 1), label])), compatibility)
  check('表格转义、实体、嵌套强调和多反引号代码按 Markdown 显示',
    compatibility.header === 'S&OP 计划' && compatibility.strong === '甲*乙* <b>' &&
    compatibility.code === 'a ` b|c &amp;' && compatibility.nested === '嵌套强调', compatibility)
  check('表格的公式和换行保持可用', compatibility.math && compatibility.lineBreak, compatibility)
  const compatibilityHref = 'https://example.com/read?a=1&b=2'
  check('正文和格内链接解码地址实体，危险协议没有生成链接',
    compatibility.bodyHrefs.includes(compatibilityHref) && compatibility.tableHref === compatibilityHref && !compatibility.unsafeHref, compatibility)
  await toggle('source', await evaluate('v.state.selection.main.head'))
  check('通用兼容修复保留文件和源码',
    await evaluate('document.getElementById("source-editor").value') === compatibilityText &&
      readFileSync(compatibilityFile, 'utf8') === compatibilityText && statSync(compatibilityFile).mtimeMs === compatibilityMtime)
  await evaluate(`document.getElementById('file-panel-files').click(); document.getElementById('file-toggle-btn').click()`)

  const separatorText = '开头😀\n\n空行后的文字 é\n\n末尾'
  const separatorFile = join(runtime, 'separator.md')
  writeFileSync(separatorFile, separatorText)
  const separatorMtime = statSync(separatorFile).mtimeMs
  await openFixture(separatorFile, separatorText)
  // 部分组合启用段落间隔排版：两换行的中点是隐藏分隔，须让到相邻可见边界。
  const hiddenSeparator = await evaluate(`!!v.dom.querySelector('.cm-md-paragraph-separator')`)
  await toggle('source', 5)
  const separatorBefore = await evaluate(`viewportProbe.place('source',5,5)`)
  const separatorAfter = await toggle('render', 5)
  const allowed = hiddenSeparator ? [4, 6] : [5]
  transcript.cases.push({ name: '隐藏分隔映射到合法可见边界', hiddenSeparator, separatorBefore, separatorAfter })
  check('分隔位置只映射到合法可见落点', separatorAfter.selection.anchor === separatorAfter.selection.head && allowed.includes(separatorAfter.selection.head) && separatorAfter.visible, { allowed, separatorAfter })
  check('分隔位置模式切换不改原文或文件', await evaluate('v.state.doc.toString()') === separatorText && readFileSync(separatorFile, 'utf8') === separatorText && statSync(separatorFile).mtimeMs === separatorMtime)

  // A的切换尚有布局测量时立即进入已渲染的B；只验目标B不受污染。
  // 源码态标签的独立选区恢复属于另一项行为，未在这里扩大要求。
  await openFixture(file, fixture)
  const tableHead = scenarios.find(s => s.name === '长表格中段').head
  await evaluate(`viewportProbe.place('render',${tableHead},${tableHead})`)
  const tabA = await evaluate(`document.querySelector('.tab-entry.active').dataset.tabId`)
  await evaluate(`document.querySelector('.tab-new-btn').click()`)
  await waitFor(`document.querySelectorAll('.tab-entry').length===2&&document.querySelector('.tab-entry.active').dataset.tabId!==${JSON.stringify(tabA)}&&v.state.doc.toString()===''`, '未建立独立B标签')
  const textB = '# 标签B\n\n' + paragraphs(35, '标签B') + '\n'
  const fileB = join(runtime, 'tab-b.md')
  writeFileSync(fileB, textB)
  const mtimeB = statSync(fileB).mtimeMs
  await openFixture(fileB, textB)
  const tabB = await evaluate(`document.querySelector('.tab-entry.active').dataset.tabId`)
  const headB = textB.indexOf('标签B012') + 10
  const beforeB = await evaluate(`viewportProbe.place('render',${headB},${headB})`)
  await evaluate(`document.querySelector('[data-tab-id="'+${JSON.stringify(tabA)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabA)}&&v.state.doc.toString()===${JSON.stringify(fixture)}`, '未返回A标签')
  await evaluate(`viewportProbe.settle('render',${tableHead})`)
  await toggle('source', tableHead)
  await evaluate(`document.getElementById('source-toggle-btn').click();document.querySelector('[data-tab-id="'+${JSON.stringify(tabB)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabB)}&&v.state.doc.toString()===${JSON.stringify(textB)}`, '快速切换后未进入B标签')
  const afterB = await evaluate(`viewportProbe.settle('render',${headB})`)
  const laterB = await evaluate(`(async()=>{for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);return viewportProbe.measure('render',${headB})})()`)
  transcript.cases.push({ name: '切换标签不污染目标', beforeB, afterB, laterB })
  check('切换模式后立即换标签保留B的原文与选区', await evaluate('v.state.doc.toString()') === textB && afterB.selection.anchor === headB && afterB.selection.head === headB, afterB)
  // 跨文档重测可能修正屏外行高估算；应保持内容锚点，而非旧的绝对scrollTop。
  check('A的待处理滚动不移动B的内容锚点', afterB.visible && laterB.visible &&
    Math.abs(beforeB.relativeY - afterB.relativeY) * afterB.viewport.height <= afterB.viewport.height * 0.12 &&
    Math.abs(afterB.caret.top - laterB.caret.top) <= 1, { beforeB, afterB, laterB })
  check('快速切换标签不改两个文件', readFileSync(file, 'utf8') === fixture && statSync(file).mtimeMs === originalMtime && readFileSync(fileB, 'utf8') === textB && statSync(fileB).mtimeMs === mtimeB)

  await evaluate(`document.querySelector('[data-tab-id="'+${JSON.stringify(tabA)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabA)}&&v.state.doc.toString()===${JSON.stringify(fixture)}`, '未回到输入测试标签')
  const editHead = scenarios[0].head
  await evaluate(`viewportProbe.place('render',${editHead},${editHead})`)
  await toggle('source', editHead)
  const inserted = '编辑😀\n新段落'
  const edited = fixture.slice(0, editHead) + inserted + fixture.slice(editHead)
  await send('Input.insertText', { text: inserted })
  const newHead = editHead + inserted.length
  const editBefore = await evaluate(`viewportProbe.settle('source',${newHead})`)
  check('源码真实输入保留UTF16光标偏移', await evaluate(`document.getElementById('source-editor').value`) === edited && editBefore.selection.anchor === newHead && editBefore.selection.head === newHead, editBefore)
  const editAfter = await toggle('render', newHead)
  transcript.cases.push({ name: '源码真实编辑后切回', editBefore, editAfter })
  check('源码编辑后切回保留新内容及光标', await evaluate('v.state.doc.toString()') === edited && editAfter.selection.anchor === newHead && editAfter.selection.head === newHead, editAfter)
  check('源码编辑后切回光标仍在附近', editAfter.visible && editAfter.focused && Math.abs(editAfter.relativeY - editBefore.relativeY) * editAfter.viewport.height <= editAfter.viewport.height * 0.12, { editBefore, editAfter })
  const editBack = await toggle('source', newHead)
  check('编辑后再次切源码保留新内容与可见光标', await evaluate(`document.getElementById('source-editor').value`) === edited && editBack.selection.anchor === newHead && editBack.selection.head === newHead && editBack.visible, editBack)

  const readingText = '# 阅读模式\n\n| 标题 | 说明 |\n| --- | --- |\n| **单元格甲** | 单元格乙 |\n'
  const readingFile = join(runtime, 'reading.md')
  writeFileSync(readingFile, readingText)
  await openFixture(readingFile, readingText)
  const readingToggle = () => evaluate(`document.getElementById('reading-mode-btn').click()`)
  await readingToggle()
  await toggle('source', 0)
  check('阅读模式可以打开只读源码', await evaluate(`document.getElementById('source-editor').readOnly && v.state.readOnly`))
  const sourceSelection = await evaluate(`(() => {
    const source = document.getElementById('source-editor')
    source.setSelectionRange(0, 6)
    return source.value.slice(source.selectionStart, source.selectionEnd)
  })()`)
  check('只读源码允许选中 Markdown 标记', sourceSelection === readingText.slice(0, 6), sourceSelection)
  await send('Input.insertText', { text: '只读不可写' })
  check('只读源码拒绝输入', await evaluate(`document.getElementById('source-editor').value`) === readingText)
  await readingToggle()
  check('在源码视图退出阅读模式可继续编辑', await mode() === 'source' && await evaluate(`!document.getElementById('source-editor').readOnly`))
  await evaluate(`document.getElementById('source-editor').setSelectionRange(2, 2)`)
  await send('Input.insertText', { text: '源码' })
  const readingEdited = readingText.slice(0, 2) + '源码' + readingText.slice(2)
  await readingToggle()
  check('在源码视图开启阅读模式保留当前视图和选区', await mode() === 'source' && await evaluate(`document.getElementById('source-editor').readOnly && document.getElementById('source-editor').selectionStart === 4`))
  await toggle('render', 4)
  check('切回只读渲染时同步此前源码修改', await evaluate('v.state.doc.toString()') === readingEdited && await evaluate('v.state.readOnly'))

  const originalTheme = await evaluate(`[...document.body.classList].find(name => name.startsWith('theme-'))`)
  for (const theme of ['dark', 'light']) {
    await evaluate(`(() => {
      for (const name of [...document.body.classList]) if (name.startsWith('theme-')) document.body.classList.remove(name)
      document.body.classList.add('theme-${theme}')
    })()`)
    await waitFor("document.querySelector('.cm-md-table-widget td strong')", '渲染表格未就绪')
    const { start, end, color } = await evaluate(`(() => {
      const [first, last] = document.querySelectorAll('.cm-md-table-widget td')
      const a = first.querySelector('strong'), b = last
      const center = (el, offset) => {
        const range = document.createRange()
        range.setStart(el.firstChild, offset)
        range.collapse(true)
        const r = range.getBoundingClientRect()
        return { x: r.x, y: r.y + r.height / 2 }
      }
      return { start: center(a, 0), end: center(b, b.textContent.length), color: getComputedStyle(a, '::selection').backgroundColor }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 })
    // 用真实复制快捷键触发 copy，接住写入内容，避免改动系统剪贴板。
    await evaluate(`window.tableCopy = null; window.addEventListener('copy', event => {
      const clipboard = new DataTransfer()
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      event.preventDefault()
      setTimeout(() => { window.tableCopy = clipboard.getData('text/plain') }, 0)
    }, { capture: true, once: true })`)
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: process.platform === 'darwin' ? 4 : 2 })
    }
    await waitFor('window.tableCopy !== null', '复制快捷键未触发 copy')
    const selected = await evaluate(`({ selection: getSelection().toString(), text: window.tableCopy, stillRendered: !!document.querySelector('.cm-md-table-widget') })`)
    check(`${theme} 阅读模式可跨单元格拖选并复制可见文本`, selected.stillRendered && selected.selection === '单元格甲\t单元格乙' && selected.text === selected.selection, selected)
    check(`${theme} 表格原生选区可见`, color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent', color)
  }
  await readingToggle()
  await evaluate(`(() => {
    getSelection().removeAllRanges()
    document.body.classList.replace('theme-light', ${JSON.stringify(originalTheme ?? 'theme-light')})
  })()`)
  const clickCell = async (column) => {
    const cell = await evaluate(`(() => {
      const r = document.querySelector('.cm-md-table-widget tbody tr').cells[${column}].getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, ...cell, button: 'left', clickCount: 1 })
    }
  }
  const pressEditorKey = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
    }
  }
  const cellDraft = 'document.activeElement.closest(".cm-md-table-cell-input") && document.activeElement.cmTile.root.view'
  await clickCell(0)
  await send('Input.insertText', { text: ' | 备注' })
  check('表格保持渲染，输入即显示在当前格且提交前原文不变', await evaluate(`
    (${cellDraft})?.state.doc.toString() === '**单元格甲** | 备注' &&
    document.querySelector('.cm-md-table-widget tbody td:nth-child(2)').textContent === '单元格乙' &&
    v.state.doc.toString() === ${JSON.stringify(readingEdited)}
  `))
  const cellThemes = await evaluate(`(async () => {
    const content = document.activeElement
    const input = content.closest('.cm-md-table-cell-input')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const original = [...document.body.classList].find(name => name.startsWith('theme-'))
    const colors = []
    for (const theme of ['light', 'dark']) {
      if (original) document.body.classList.remove(original)
      document.body.classList.add('theme-' + theme)
      const box = input.getBoundingClientRect()
      const cell = input.parentElement.getBoundingClientRect()
      const widthDelta = Math.abs(box.width - cell.width)
      const heightDelta = Math.abs(box.height - cell.height)
      const cursor = input.querySelector('.cm-cursor-primary')
      const bounds = cursor?.getBoundingClientRect()
      const cursorColor = cursor && getComputedStyle(cursor).borderLeftColor
      const caretVisible = bounds?.width > 0 && bounds.height > 0 &&
        bounds.left >= box.left && bounds.right <= box.right &&
        bounds.top >= box.top && bounds.bottom <= box.bottom &&
        cursorColor === getComputedStyle(content).color
      colors.push({ background: getComputedStyle(input).backgroundColor, aligned: widthDelta < 3 && heightDelta < 3, widthDelta, heightDelta, caretVisible, cursorColor })
      document.body.classList.remove('theme-' + theme)
    }
    if (original) document.body.classList.add(original)
    return colors
  })()`)
  check('单元格输入框在浅色和深色主题中贴合网格', cellThemes.every(style => style.aligned) &&
    cellThemes[0].background !== cellThemes[1].background, cellThemes)
  check('编辑单元格时光标在深浅主题中可见', cellThemes.every(style => style.caretVisible), cellThemes)
  await pressEditorKey('Tab', 9)
  const cellEdited = readingEdited.replace('**单元格甲**', '**单元格甲** \\| 备注')
  check('Tab 确认后只写回当前格，竖线显示为文字并进入下一格', await evaluate(`
    v.state.doc.toString() === ${JSON.stringify(cellEdited)} &&
    document.querySelector('.cm-md-table-widget tbody tr').cells.length === 2 &&
    document.querySelector('.cm-md-table-widget tbody td').textContent === '单元格甲 | 备注' &&
    (${cellDraft})?.state.doc.toString() === '单元格乙'
  `))
  await send('Input.insertText', { text: '放弃的输入' })
  await pressEditorKey('Enter', 13, 8)
  check('Shift+Enter 在当前格草稿内换行', await evaluate(
    `(${cellDraft})?.state.doc.toString() === ${JSON.stringify('单元格乙放弃的输入\n')}`,
  ))
  await pressEditorKey('Escape', 27)
  check('Esc 取消当前格的输入', await evaluate(`!document.querySelector('.cm-md-table-cell-input') &&
    v.state.doc.toString() === ${JSON.stringify(cellEdited)}`))

  await clickCell(1)
  await evaluate(`(() => { const draft = ${cellDraft}; draft.dispatch({ selection: { anchor: 0, head: draft.state.doc.length } }) })()`)
  const editedMarkup = '**新的说明** [链接](https://example.com) 与 $x_1$ 和 ' + String.fromCharCode(96) + '字段' + String.fromCharCode(96)
  await send('Input.insertText', { text: editedMarkup })
  check('当前格边输入边渲染且提交前只改草稿', await evaluate(`(() => {
    const content = document.activeElement
    return content.querySelector('strong')?.textContent === '新的说明' &&
      content.querySelector('.cm-md-link')?.textContent === '链接' &&
      !!content.querySelector('.cm-md-math .katex') &&
      content.querySelector('code')?.textContent === '字段' &&
      v.state.doc.toString() === ${JSON.stringify(cellEdited)}
  })()`))
  await evaluate(`(${cellDraft}).dispatch({ selection: { anchor: 4 } })`)
  check('只展开当前编辑的格式，格内其余标记继续渲染', await evaluate(`(() => {
    const content = document.activeElement
    return content.textContent.includes('**新的说明**') &&
      content.querySelector('.cm-md-link')?.textContent === '链接' &&
      content.querySelector('code')?.textContent === '字段' &&
      !content.textContent.includes('https://example.com')
  })()`))
  await pressEditorKey('Enter', 13)
  const formattedCell = cellEdited.replace('单元格乙', editedMarkup)
  check('Enter 确认后渲染当前格的 Markdown 格式', await evaluate(`
    v.state.doc.toString() === ${JSON.stringify(formattedCell)} &&
    document.querySelector('.cm-md-table-widget td:nth-child(2) strong')?.textContent === '新的说明'
  `))
  await pressEditorKey('z', 90, process.platform === 'darwin' ? 4 : 2)
  check('撤销只还原最近一次单元格确认', await evaluate(`v.state.doc.toString() === ${JSON.stringify(cellEdited)}`))

  await clickCell(1)
  await send('Input.insertText', { text: '待确认' })
  const sourceAfterCell = cellEdited.replace('单元格乙', '单元格乙待确认')
  const editedCellStart = sourceAfterCell.indexOf('单元格乙待确认')
  await toggle('source', editedCellStart)
  check('切到源码前确认单元格并定位该格', await evaluate(`(() => {
    const source = document.getElementById('source-editor')
    return source.value === ${JSON.stringify(sourceAfterCell)} && source.selectionStart === ${editedCellStart}
  })()`))
  await toggle('render', editedCellStart)
  await readingToggle()
  check('在表格源码内开启阅读模式会恢复表格渲染', await evaluate(`v.state.readOnly && !!document.querySelector('.cm-md-table-widget')`))
  await readingToggle()
  await evaluate(`v.dispatch({ selection: { anchor: 0 } })`)
  await clickCell(1)
  await send('Input.insertText', { text: '点走' })
  const headingPoint = await evaluate(`(() => {
    const r = document.querySelector('#editor .cm-md-atxheading1').getBoundingClientRect()
    return { x: r.left + 16, y: r.top + r.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, ...headingPoint, button: 'left', clickCount: 1 })
  }
  const cellAfterBlur = sourceAfterCell.replace('待确认', '待确认点走')
  check('点到格外确认当前草稿', await evaluate(`!document.querySelector('.cm-md-table-cell-input') &&
    v.state.doc.toString() === ${JSON.stringify(cellAfterBlur)}`))

  await clickCell(1)
  await send('Input.insertText', { text: '切标签' })
  const cellBeforeLeaving = cellAfterBlur.replace('点走', '点走切标签')
  await evaluate(`document.querySelector('[data-tab-id="'+${JSON.stringify(tabB)}+'"]').click()`)
  await waitFor(`document.querySelector('.tab-entry.active').dataset.tabId===${JSON.stringify(tabB)} &&
    v.state.doc.toString()===${JSON.stringify(textB)}`, '切标签前未确认表格内容')
  check('切标签前确认编辑，并且只保存到原文件', readFileSync(readingFile, 'utf8') === cellBeforeLeaving &&
    readFileSync(fileB, 'utf8') === textB && statSync(fileB).mtimeMs === mtimeB)

  const previewImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#345"/></svg>').toString('base64')
  const wideTableText = [
    '# 窄窗口中的表格', '',
    '| 参数键名 | 工程用途 | 推荐值一 | 推荐值二 | 推荐值三 |',
    '| --- | --- | --- | --- | --- |',
    '| `parenthesized_elevation_as_beam_top` | 梁顶标高判定 | false | false | true |',
    '| ![表内图注](data:image/svg+xml;base64,' + previewImage + ') | 查看工程图 | A | B | C |', '',
  ].join('\n')
  const wideTableFile = join(runtime, 'scroll-and-image.md')
  writeFileSync(wideTableFile, wideTableText)
  await openFixture(wideTableFile, wideTableText)
  await readingToggle()
  await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 780, deviceScaleFactor: 1, mobile: false })
  await waitFor("document.querySelector('.cm-md-table-scroll img')?.naturalWidth === 1600", '表格图片未加载')
  const galleryPoint = await evaluate(`(() => {
    const rect = document.querySelector('.cm-md-table-scroll img').getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, ...galleryPoint, button: 'left', clickCount: 1 })
  }
  await waitFor("document.querySelector('.cm-image-overlay.open img')?.naturalWidth === 1600", '单击表格图片未打开原图')
  check('阅读模式单击格内图打开带图注的原图', await evaluate(`
    document.querySelector('.cm-image-overlay.open img').alt === '表内图注' &&
    !document.querySelector('.cm-md-table-cell-input')`))
  await evaluate(`(() => {
    const image = document.querySelector('.cm-image-overlay.open img')
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })()`)
  await waitFor("document.querySelector('.cm-image-overlay.can-pan.open')", '原图放大后不可平移')
  await pause(160)
  const panStart = await evaluate("document.querySelector('.cm-image-overlay img').getBoundingClientRect().left")
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 240, y: 390, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 330, y: 390, button: 'left', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 330, y: 390, button: 'left', clickCount: 1 })
  check('放大后的原图支持鼠标拖动',
    await evaluate("document.querySelector('.cm-image-overlay.open img').getBoundingClientRect().left") - panStart > 60)
  await pressEditorKey('Escape', 27)
  await waitFor("!document.querySelector('.cm-image-overlay.open')", '未关闭原图查看器')
  const tablePoint = await evaluate(`(() => {
    const rect = document.querySelector('.cm-md-table-scroll').getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + 24 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...tablePoint, deltaX: 1000, deltaY: 0 })
  await waitFor("document.querySelector('.cm-md-table-scroll').scrollLeft > 0", '宽表格没有横向滚动')
  check('窄窗口横向滚动只移动表格，长参数名可读', await evaluate(`(() => {
    const wrap = document.querySelector('.cm-md-table-scroll')
    const code = wrap.querySelector('code')
    const text = document.createRange()
    text.selectNodeContents(code)
    return wrap.scrollLeft > 0 && v.scrollDOM.scrollLeft === 0 &&
      v.scrollDOM.scrollWidth <= v.scrollDOM.clientWidth + 1 && text.getClientRects().length === 1
  })()`))
  await readingToggle()
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false })

  const tableRowsForLayout = [
    ['任务清单输出', '表格只列出每项任务自己的编号、名称和进度，缺少关联信息，还要手工翻查其他记录。', '自动列出当前分组内每项任务的关联记录，并按实际进度输出一份完整清单。'],
    ['分类排序与去重', '手工整理时容易把同一分组内的相邻任务、不同分组内的重复任务记错。', '先按当前的分类规则确定任务分组，再按统一的标准排序并去重。'],
    ['筛选条件与范围', '包含已归档或状态不详的记录时，手动筛选容易跳过需要核对的条目。', '可以明确选择时间范围与处理状态，也可以一次查看所有待确认的条目。'],
    ['页面预览与更正', '选中一条记录时看不出还有哪些关联条目，需要在两个页面之间来回切换。', '可以在预览中展开和更正关联条目，选中的记录会同时在列表里高亮。'],
    ['导出表格稳定性', '删除一条重复记录或只导出其中一个分组时，手工写入的行号容易错位。', '使用记录自己的编号进行匹配，导出时按照当前的显示顺序重新编号。'],
    ['结果一致性', '不同人先后两次手工整理，最终的任务排列顺序不统一。', '先确定每个分组的顺序，再按组内编号排列，便于核对前后两次结果。'],
  ]
  const markdownTable = (head, columns) => [head, ['---', '---', '---'],
    ...tableRowsForLayout.map(row => columns.map(index => index === 0 ? `**${row[index]}**` : row[index])),
  ].map(row => `| ${row.join(' | ')} |`).join('\n')
  const layoutText = '# 表格列宽\n\n' + markdownTable(['对比维度', '功能添加前', '功能添加后'], [0, 1, 2]) + '\n\n' +
    markdownTable(['A', 'B', 'C'], [1, 2, 0]) + '\n'
  const layoutFile = join(runtime, 'table-layout.md')
  writeFileSync(layoutFile, layoutText)
  await openFixture(layoutFile, layoutText)
  await evaluate(`window.measureTables = () => Array.from(document.querySelectorAll('.cm-md-table-widget'), (table, index) => {
    const column = index === 0 ? 0 : 2
    const countLines = (cell) => {
      const range = document.createRange()
      range.selectNodeContents(cell.querySelector('strong') || cell)
      return Math.max(1, range.getClientRects().length)
    }
    const size = () => ({
      wrappedLabels: Array.from(table.tBodies[0].rows).filter(row => countLines(row.cells[column]) > 1).length,
      lines: Array.from(table.rows).reduce((sum, row) => sum + Array.from(row.cells).reduce((subtotal, cell) => subtotal + countLines(cell), 0), 0),
      fits: table.offsetWidth <= table.parentElement.clientWidth + 1,
    })
    const adjusted = size()
    const headers = Array.from(table.tHead.rows[0].cells)
    const widths = headers.map(th => th.style.getPropertyValue('--cm-md-column-min-width'))
    for (const th of headers) th.style.removeProperty('--cm-md-column-min-width')
    const automatic = size()
    headers.forEach((th, i) => { if (widths[i]) th.style.setProperty('--cm-md-column-min-width', widths[i]) })
    return { adjusted, automatic, widths }
  })`)
  const layoutWide = await evaluate('measureTables()')
  check('根据实际折行改善短文本列，列名和位置不影响判断', layoutWide.length === 2 && layoutWide.every(({ adjusted, automatic }) =>
    adjusted.fits && adjusted.wrappedLabels === 0 && automatic.wrappedLabels > 0 && adjusted.lines < automatic.lines), layoutWide)
  await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 780, deviceScaleFactor: 1, mobile: false })
  await evaluate('viewportProbe.settle("render", 0)')
  const layoutNarrow = await evaluate('measureTables()')
  check('窗口变窄后重新分配列宽并保持表格放得下', layoutNarrow.length === 2 && layoutNarrow.every(({ adjusted, automatic }) =>
    adjusted.fits && adjusted.lines <= automatic.lines), layoutNarrow)
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 780, deviceScaleFactor: 1, mobile: false })

  const cjkText = [
    '# 中文强调',
    '',
    '1. **分组与排序原则**',
    '   - 查询范围限定在**当前分组（含已归档记录）**内部，其他分组单独处理；',
    '   - 在这里注明*“无需逐项核对”*、在另一项注明*“排序规则见下文”*。',
    '',
    '边界：word*"literal"*word，`注明*“代码”*`，\\*“已转义”\\*。',
    '',
    '普通强调：中文**加粗**和*斜体*。',
    '',
  ].join('\n')
  const cjkFile = join(runtime, 'cjk-emphasis.md')
  writeFileSync(cjkFile, cjkText)
  await openFixture(cjkFile, cjkText)
  const cjkRendering = await evaluate(`(() => {
    const content = v.contentDOM
    const marks = (selector) => Array.from(content.querySelectorAll(selector), mark => mark.textContent)
    return { bold: marks('.cm-md-strong'), italic: marks('.cm-md-em'), code: marks('.cm-md-inlinecode'), text: content.textContent }
  })()`)
  check('中文闭括号后的星号可以闭合加粗', cjkRendering.bold.includes('当前分组（含已归档记录）') &&
    cjkRendering.text.includes('当前分组（含已归档记录）内部'), cjkRendering)
  check('两处中文引号分别斜体，中间文字维持正文', JSON.stringify(cjkRendering.italic) ===
    JSON.stringify(['“无需逐项核对”', '“排序规则见下文”', '斜体']), cjkRendering)
  check('普通强调、行内代码与字面星号继续正常解析', cjkRendering.bold.includes('加粗') &&
    cjkRendering.code.includes('注明*“代码”*') && cjkRendering.text.includes('word*"literal"*word') &&
    cjkRendering.text.includes('*“已转义”*'), cjkRendering)
  check('中文强调预览保留源码及磁盘字节', await evaluate('v.state.doc.toString()') === cjkText && readFileSync(cjkFile, 'utf8') === cjkText)

  // 源码位置按真实排版测量，代价随光标前的文字线性增长。用接近整篇源码阈值
  // （512K 字符）的文档记录切换耗时，防止退化成多次全文排版。
  let large = '', index = 0
  while (large.length < 500 * 1024) large += `长文${index++}：普通正文混合 **加粗** 和 [链接](https://example.com/${index})。${'正文内容和 English words 连续排列，记录切换耗时。'.repeat(6)}\n\n`
  const largeFile = join(runtime, 'large.md')
  writeFileSync(largeFile, large)
  await openFixture(largeFile, large)
  const timing = {}
  for (const [name, position] of [['文首', 10], ['文末', large.length - 10]]) {
    await evaluate(`viewportProbe.place('render',${position},${position})`)
    const runs = []
    for (let i = 0; i < 3; i++) {
      const toSource = await evaluate(`(()=>{const t=performance.now();document.getElementById('source-toggle-btn').click();return performance.now()-t})()`)
      await evaluate(`viewportProbe.settle('source',${position})`)
      const toRender = await evaluate(`(()=>{const t=performance.now();document.getElementById('source-toggle-btn').click();return performance.now()-t})()`)
      await evaluate(`viewportProbe.settle('render',${position})`)
      runs.push({ toSource, toRender })
    }
    const median = key => runs.map(r => r[key]).sort((a, b) => a - b)[1]
    timing[name] = { runs, toSource: median('toSource'), toRender: median('toRender') }
  }
  transcript.performance = { characters: large.length, bytes: Buffer.byteLength(large), timing }
  console.log('切换耗时（毫秒，中位数）', JSON.stringify(Object.fromEntries(Object.entries(timing).map(([k, t]) => [k, [Math.round(t.toSource), Math.round(t.toRender)]]))))
  check('接近阈值的长文切换在文末仍在一次排版的量级', timing['文末'].toSource < 600 && timing['文末'].toRender < 600, timing)
  check('运行没有编辑器异常', errors.length === 0, errors)
  exitCode = failures.length ? 1 : 0
} catch (error) {
  transcript.harnessError = error.stack ?? String(error)
  console.error(transcript.harnessError)
} finally {
  transcript.passed = results.filter(r => r.passed).length
  transcript.failed = failures.length
  transcript.exitCode = exitCode
  if (launchOutput) transcript.launchOutput = launchOutput
  if (ws) ws.close()
  stopVerifyApp(udd)
  if (child.exitCode === null) child.kill('SIGTERM')
  if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(2000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  const report = out ? join(out, `${label}.json`) : null
  if (report) writeFileSync(report, JSON.stringify(transcript, null, 2) + '\n')
  console.log(JSON.stringify({ passed: transcript.passed, failed: transcript.failed, exitCode, report }))
}
process.exitCode = exitCode
