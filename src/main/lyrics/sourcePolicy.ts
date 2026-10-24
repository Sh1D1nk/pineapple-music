/**
 * 歌词源的取用策略（纯函数，便于单测）。
 *
 * 语义：
 * - `priority` 决定尝试顺序：sidecar（外挂文件）→ embedded（内嵌标签）→ text（纯文本）；
 * - `autoFallback` 关闭时只尝试第一个来源，取不到就如实返回「无歌词」，
 *   不悄悄换源（用户明确要求「内嵌优先」时，外挂文件不该抢在前面）。
 */

export type LyricSourceKind = 'sidecar' | 'embedded' | 'text'

/** 按优先级与自动回退开关，决定实际要尝试哪些来源。 */
export function effectiveSources(
  priority: LyricSourceKind[],
  autoFallback: boolean
): LyricSourceKind[] {
  const clean = priority.filter((s): s is LyricSourceKind =>
    s === 'sidecar' || s === 'embedded' || s === 'text'
  )
  if (clean.length === 0) return []
  return autoFallback ? clean : clean.slice(0, 1)
}

/** 缓存键必须包含「回退模式」，否则切换开关后会命中旧缓存、看起来像没生效。 */
export function lyricsCacheStamp(input: {
  sidecarPath: string | null
  sidecarMtimeMs: number
  songMtimeMs: number
  priority: LyricSourceKind[]
  autoFallback: boolean
}): string {
  const sidecar = input.sidecarPath
    ? `${input.sidecarPath}:${input.sidecarMtimeMs}`
    : 'none'
  const mode = input.autoFallback ? 'fb' : 'strict'
  return `${sidecar}|${input.songMtimeMs}|${input.priority.join(',')}|${mode}`
}
