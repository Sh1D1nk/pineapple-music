import hyaliteUrl from '../vendor/hyalite/hyalite.js?url'
import type { HyaliteAPI, HyaliteOptions } from '../vendor/hyalite/hyalite'

let loading: Promise<HyaliteAPI | null> | null = null

/**
 * hyalite.js is a classic script (window.Hyalite). Loading it from a URL keeps it byte-identical
 * to the upstream release — including the licence header — and avoids bundling it as ESM.
 */
export function loadHyalite(): Promise<HyaliteAPI | null> {
  if (typeof window !== 'undefined' && window.Hyalite) return Promise.resolve(window.Hyalite)
  if (loading) return loading
  loading = new Promise<HyaliteAPI | null>((resolve) => {
    const script = document.createElement('script')
    script.src = hyaliteUrl
    script.async = true
    script.onload = () => resolve(window.Hyalite ?? null)
    script.onerror = () => resolve(null)
    document.head.appendChild(script)
  })
  return loading
}

/**
 * 小控件（悬浮底栏胶囊 / 圆形按钮 / 菜单）的折射配方。
 *
 * 对齐 Kyant0/AndroidLiquidGlass 的 Glass Bottom Bar：边缘折射带约 16px、
 * 最大位移约 32px、模糊约 4px、色散 0–1.2。
 * Hyalite 的位移由 thickness 驱动（bevel 16 / thickness 34 只有 8.8px，
 * 这正是上一版“看不出折射”的直接原因），所以把 slab 加厚到 120。
 * 实际上限用 HUD 里的 maxDisplacement 读回；目标 30–34px。
 */
export const FULL_OPTIONS: HyaliteOptions = {
  bevel: 16,
  thickness: 150,
  dispersion: 1.4,
  blur: 4,
  slope: 2.6,
  shape: 'squircle',
  sat: 0.96,
  shade: 0.32,
  rim: 1.8,
  edgeW: 8,
  light: -140,
  materialize: 180
}

/** 上一版参数（bevel 18 / thickness 34，实测最大位移 8.8px）：只给 A/B 对照用。 */
export const LEGACY_FULL_OPTIONS: HyaliteOptions = {
  bevel: 18,
  thickness: 34,
  dispersion: 1.4,
  blur: 2,
  slope: 2.2,
  sat: 0.9,
  shade: 0.42,
  rim: 1.7,
  edgeW: 7,
  light: -140,
  materialize: 180
}

export const LITE_OPTIONS: HyaliteOptions = {
  bevel: 16,
  thickness: 26,
  slope: 0.9,
  dispersion: 0,
  smooth: 0,
  sat: 1,
  blur: 7,
  shade: 0.36,
  rim: 1.4,
  edgeW: 10,
  light: -140,
  materialize: 260,
  settle: 120
}

export type { HyaliteAPI, HyaliteOptions }
