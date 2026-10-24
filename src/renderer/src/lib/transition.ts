/**
 * 视图切换动画。
 *
 * 用 Chromium 的 View Transitions 做「旧界面淡出 → 新界面淡入」，并让被点中的封面
 * 通过 `view-transition-name` 从网格位置形变到详情页大图位置；弹性曲线放在
 * `::view-transition-group(album-cover)` 上，于是缩放会轻微过冲再回落（果冻感）。
 * 不支持或被系统要求减少动效时，直接执行回调，不做任何降级延迟。
 */
const REDUCED = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const MORPH_COVER = 'album-cover'

/** 记住「上一次点开的专辑」，返回时让同一张卡片成为形变目标，封面才能缩回去。 */
let morphAlbum: string | null = null
export const setMorphAlbum = (key: string | null): void => {
  morphAlbum = key
}
export const getMorphAlbum = (): string | null => morphAlbum

let pending = false

/**
 * 视图切换。`dir` 只在需要「方向性滚动」时传（主导航），
 * 专辑封面形变不需要方向 —— 由 `view-transition-group(album-cover)` 自己处理。
 */
export function withViewTransition(update: () => void, dir: 'up' | 'down' | 'none' = 'none'): void {
  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => { finished?: Promise<void> } | undefined
  }
  if (typeof doc.startViewTransition !== 'function' || REDUCED() || pending) {
    update()
    return
  }
  const root = document.documentElement
  root.dataset.nav = dir
  // 快照期间关掉入场动画，否则旧/新两帧都可能是透明度 0，形变会闪
  root.dataset.vt = '1'
  try {
    const transition = doc.startViewTransition(update)
    pending = true
    const done = (): void => {
      pending = false
      delete root.dataset.nav
      delete root.dataset.vt
    }
    if (transition?.finished) transition.finished.then(done).catch(done)
    else window.setTimeout(done, 600)
  } catch {
    update()
    pending = false
    delete root.dataset.nav
    delete root.dataset.vt
  }
}

/** 临时给元素挂上形变名；过渡结束后清掉，避免下一次切换重复命中。 */
export function markMorph(el: Element | null | undefined): void {
  if (!(el instanceof HTMLElement)) return
  el.style.viewTransitionName = MORPH_COVER
  window.setTimeout(() => {
    if (el.style.viewTransitionName === MORPH_COVER) el.style.viewTransitionName = ''
  }, 900)
}
