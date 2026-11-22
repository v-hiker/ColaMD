import { isChinese } from '../ui-language'

let openOverlay: ((src: string, alt: string) => void) | undefined

export function openImageOverlay(src: string, alt = ''): void {
  (openOverlay ??= createOverlay())(src, alt)
}

function createOverlay(): (src: string, alt: string) => void {
  const box = document.createElement('div')
  box.className = 'cm-image-overlay'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const img = document.createElement('img')
  img.draggable = false
  const caption = document.createElement('div')
  caption.className = 'cm-image-overlay-caption'
  box.append(img, caption)
  document.body.appendChild(box)

  let scale = 1
  let left = 0
  let top = 0
  let drag: { pointer: number; x: number; y: number } | null = null

  // Clamp each axis against the untransformed image and the current viewport.
  function boundedOffset(value: number, start: number, size: number, viewport: number): number {
    if (size * scale <= viewport) return 0
    const extra = size * (scale - 1) / 2
    const min = viewport - start - size - extra
    const max = extra - start
    return Math.max(min, Math.min(max, value))
  }

  function updateTransform(): void {
    if (!box.classList.contains('open')) return
    left = boundedOffset(left, img.offsetLeft, img.offsetWidth, box.clientWidth)
    top = boundedOffset(top, img.offsetTop, img.offsetHeight, box.clientHeight)
    box.classList.toggle('can-pan',
      img.offsetWidth * scale > box.clientWidth || img.offsetHeight * scale > box.clientHeight)
    img.style.transform = scale === 1 && left === 0 && top === 0
      ? '' : `translate(${left}px, ${top}px) scale(${scale})`
  }

  function finishDrag(): void {
    const pointer = drag?.pointer
    drag = null
    if (pointer !== undefined && img.hasPointerCapture(pointer)) img.releasePointerCapture(pointer)
    box.classList.remove('panning')
  }

  function close(): void {
    finishDrag()
    box.classList.remove('open')
  }

  img.addEventListener('wheel', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const next = event.deltaY > 0 ? scale / 1.15 : scale * 1.15
    scale = Math.min(8, Math.max(0.15, next))
    updateTransform()
  }, { passive: false })
  img.addEventListener('dblclick', (event) => {
    event.stopPropagation()
    scale = scale === 1 ? 2 : 1
    updateTransform()
  })
  img.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag || !box.classList.contains('can-pan')) return
    drag = { pointer: event.pointerId, x: event.clientX - left, y: event.clientY - top }
    img.setPointerCapture(event.pointerId)
    box.classList.add('panning')
  })
  img.addEventListener('pointermove', (event) => {
    if (drag?.pointer !== event.pointerId) return
    left = event.clientX - drag.x
    top = event.clientY - drag.y
    updateTransform()
  })
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    img.addEventListener(type, (event) => {
      if (drag?.pointer === event.pointerId) finishDrag()
    })
  }
  img.addEventListener('click', (event) => event.stopPropagation())
  img.addEventListener('load', updateTransform)
  window.addEventListener('resize', updateTransform)
  box.addEventListener('click', close)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !box.classList.contains('open')) return
    close()
    event.preventDefault()
    event.stopPropagation()
  }, true)

  return (src, alt) => {
    finishDrag()
    scale = 1
    left = top = 0
    img.style.transform = ''
    img.src = src
    img.alt = alt
    caption.textContent = alt.trim() || (isChinese()
      ? '滚轮缩放 · 放大后拖动 · Esc 关闭'
      : 'Scroll to zoom · drag to pan · Esc to close')
    box.classList.add('open')
    updateTransform()
  }
}
