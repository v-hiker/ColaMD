import type { WebContents } from 'electron'
import type { WordFontFamilies } from '../shared/word-export'

const PROBE_ID = 'colamd-word-font-probe'

/** Find the installed fonts Chromium chose for Latin and Chinese text. */
export async function resolveWordFonts(contents: WebContents, fontStack: unknown): Promise<WordFontFamilies> {
  if (typeof fontStack !== 'string' || fontStack.length > 1500 || contents.isDestroyed() ||
      contents.isDevToolsOpened() || contents.debugger.isAttached()) return {}

  const session = contents.debugger
  let attached = false
  try {
    session.attach('1.3')
    attached = true
    const selectors = await contents.executeJavaScript(`(() => {
      const probe = document.createElement('div');
      probe.id = ${JSON.stringify(PROBE_ID)};
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      probe.style.fontFamily = ${JSON.stringify(fontStack)};
      for (const text of ['Report design 2026', '结构梁柱图纸工程分析']) {
        const span = document.createElement('span');
        span.textContent = text;
        probe.append(span);
      }
      document.body.append(probe);
      probe.getBoundingClientRect();

      // Consult the rendered document for East Asian fallback. The browser's
      // generic fallback can differ between plain probes and existing lines.
      const editor = document.querySelector('#editor .cm-content');
      if (!editor || getComputedStyle(editor).fontFamily !== ${JSON.stringify(fontStack)}) return {};
      const result = {};
      for (const [index, line] of Array.from(editor.children).entries()) {
        if (!line.classList.contains('cm-line')) continue;
        const text = Array.from(line.childNodes).filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent).join('');
        const han = text.match(/\\p{Script=Han}/gu)?.length ?? 0;
        const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
        if (han < 3 || han < latin * 2) continue;
        const isHeading = Array.from(line.classList).some(name => /^cm-md-atxheading[1-6]$/.test(name));
        const key = isHeading ? 'heading' : 'body';
        result[key] ??= '#editor .cm-content > :nth-child(' + (index + 1) + ')';
        if (result.body && result.heading) break;
      }
      return result;
    })()`)
    await session.sendCommand('DOM.enable')
    await session.sendCommand('CSS.enable')
    const { root } = await session.sendCommand('DOM.getDocument')
    const fontAt = async (selector: string | undefined): Promise<string | undefined> => {
      if (!selector) return undefined
      const { nodeId } = await session.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) return undefined
      const { fonts } = await session.sendCommand('CSS.getPlatformFontsForNode', { nodeId }) as {
        fonts: Array<{ familyName: string; glyphCount: number; isCustomFont: boolean }>
      }
      return fonts.filter(({ familyName, isCustomFont }) => !isCustomFont && !familyName.startsWith('.'))
        .sort((a, b) => b.glyphCount - a.glyphCount)[0]?.familyName
    }
    const [latin, sampledEastAsia, bodyEastAsia, headingEastAsia] = await Promise.all([
      fontAt(`#${PROBE_ID} > span:first-child`), fontAt(`#${PROBE_ID} > span:last-child`),
      fontAt(selectors.body), fontAt(selectors.heading),
    ])
    return { latin, eastAsia: bodyEastAsia ?? headingEastAsia ?? sampledEastAsia, headingEastAsia }
  } catch {
    return {}
  } finally {
    if (attached && !contents.isDestroyed()) {
      if (session.isAttached()) session.detach()
      await contents.executeJavaScript(`document.getElementById(${JSON.stringify(PROBE_ID)})?.remove()`).catch(() => {})
    }
  }
}
