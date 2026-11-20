/** 玻璃表面的运行时统计：HUD 与 bench 用，不参与渲染逻辑。 */
export const glassStats = {
  fullSurfaces: 0,
  liteSurfaces: 0,
  /** Hyalite 每次重建位移图 +1 */
  builds: 0,
  /** 最近一次重建的位移图尺寸（HUD 判断是否被降采样） */
  lastMapSize: [0, 0] as [number, number],
  /** 最近一次 build 后的最大位移（px），验收线 ≈ 32 */
  maxDisplacement: 0,
  /** 最近一次 rebuild 的耗时（ms，从 attach/refresh 调用到 build 回调） */
  lastBuildMs: 0,
  /** 累计 rebuild 耗时（ms） */
  totalBuildMs: 0
}

let buildStartedAt = 0

export function noteBuildStart(): void {
  buildStartedAt = performance.now()
}

export function noteBuild(info: { mapSize: [number, number]; maxDisplacement: number }): void {
  glassStats.builds++
  glassStats.lastMapSize = info.mapSize
  glassStats.maxDisplacement = Math.round(info.maxDisplacement * 10) / 10
  if (buildStartedAt > 0) {
    const dt = performance.now() - buildStartedAt
    glassStats.lastBuildMs = Math.round(dt * 10) / 10
    glassStats.totalBuildMs += dt
  }
  buildStartedAt = 0
}

/** 统计当前 DOM 里有多少块真正挂了折射的玻璃（.glassFull）与面积。 */
export function measureGlassSurfaces(): { full: number; lite: number; area: number } {
  let full = 0
  let lite = 0
  let area = 0
  for (const el of Array.from(document.querySelectorAll('.glassFull, .glassLite'))) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    const isFull = el.classList.contains('glassFull')
    if (isFull) full++
    else lite++
    area += rect.width * rect.height
  }
  glassStats.fullSurfaces = full
  glassStats.liteSurfaces = lite
  return { full, lite, area: Math.round(area) }
}
