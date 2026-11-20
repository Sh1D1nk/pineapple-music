import type { View } from '../state/store'

/** 与 store.setView 共用的稳定 key：冷/热统计与 data 阶段归属都按它对齐。 */
export function viewOpenKey(view: View): string {
  if (view.kind === 'album') return `album:${view.key}`
  if (view.kind === 'artist') return `artist:${view.name}`
  return view.kind
}
