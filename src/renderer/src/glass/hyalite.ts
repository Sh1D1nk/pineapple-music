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

export const FULL_OPTIONS: HyaliteOptions = {
  // Pills and round buttons: the bevel clamps to half the short side, so 18 reads correctly on
  // both a 48px capsule and a 40px circle.
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
