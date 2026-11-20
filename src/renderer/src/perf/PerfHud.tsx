import { useEffect, useMemo, useState, type JSX } from 'react'
import { frameBudgetMs, openStats, recentLongTasks, recentOpens, type FrameSummary, type OpenSample } from './core'
import { glassStats, measureGlassSurfaces } from '../glass/stats'
import { useStore } from '../state/store'
import styles from './PerfHud.module.css'

interface MainPerf {
  loop: { p50: number; p95: number; max: number }
  cpu: number
  cores: number
  handles: number
  memoryMb: number
  gpu: { vendor: string; device: string; driver: string; feature: string; accelerated: boolean }
  display: { width: number; height: number; refresh: number; scale: number }
  stems: { active: boolean; stage: string; percent: number }
  inputIdleMs: number
}

const fmt = (value: number | null, digits = 1): string =>
  value === null || Number.isNaN(value) ? '—' : value.toFixed(digits)

function bar(value: number, budget: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const cells = Math.min(24, Math.max(0, Math.round((value / (budget * 4)) * 24)))
  return '█'.repeat(cells)
}

export function PerfHud({ active }: { active: boolean }): JSX.Element | null {
  const [tick, setTick] = useState(0)
  const [main, setMain] = useState<MainPerf | null>(null)
  const analysis = useStore((s) => s.analysis)
  const scan = useStore((s) => s.scan)
  const netConnected = useStore((s) => s.netStatus.connected)
  const budget = frameBudgetMs()

  useEffect(() => {
    if (!active) return undefined
    let alive = true
    const pull = (): void => {
      void window.lm
        .invoke<MainPerf>('perf/main')
        .then((value) => {
          if (alive) setMain(value)
        })
        .catch(() => undefined)
      measureGlassSurfaces()
      if (alive) setTick((n) => n + 1)
    }
    pull()
    const timer = window.setInterval(pull, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [active])

  const frames: FrameSummary = useMemo(() => window.__perf?.frames() ?? { p50: 0, p95: 0, p99: 0, max: 0, fps: 0, samples: 0 }, [tick])
  const stats = useMemo(() => openStats(), [tick])
  const opens: OpenSample[] = useMemo(() => recentOpens().slice(-10).reverse(), [tick])
  const tasks = useMemo(() => recentLongTasks(5), [tick])
  const surfaces = useMemo(() => measureGlassSurfaces(), [tick])

  if (!active) return null

  const overBudget = frames.p95 > budget * 1.5
  return (
    <div className={styles.hud} role="status" aria-live="polite">
      <header className={styles.head}>
        <span>性能 HUD</span>
        <span className={styles.hint}>Ctrl+Shift+P 关闭</span>
      </header>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>帧</span>
          <b className={overBudget ? styles.bad : styles.good}>{frames.fps.toFixed(0)} fps</b>
        </div>
        <div className={styles.mono}>
          p50 {fmt(frames.p50)} · p95 {fmt(frames.p95)} · p99 {fmt(frames.p99)} · max {fmt(frames.max)} (预算 {budget.toFixed(1)})
        </div>
        <div className={styles.spark}>{bar(frames.p95, budget)}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>主进程事件循环</span>
          <b>{main ? `${fmt(main.loop.p95)} ms` : '…'}</b>
        </div>
        <div className={styles.mono}>
          p50 {fmt(main?.loop.p50 ?? null)} · max {fmt(main?.loop.max ?? null)} · CPU {main ? main.cpu.toFixed(0) : '—'}% · 句柄 {main?.handles ?? '—'}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>点开延迟（热）</span>
          <b className={stats.hot.p95 > 50 ? styles.bad : styles.good}>
            p95 {stats.hot.p95} ms / n={stats.hot.n}
          </b>
        </div>
        <div className={styles.row}>
          <span>点开延迟（冷）</span>
          <b className={stats.cold.p95 > 150 ? styles.bad : styles.good}>
            p95 {stats.cold.p95} ms / n={stats.cold.n}
          </b>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>目标</th>
              <th>冷/热</th>
              <th>总</th>
              <th>同步</th>
              <th>封面</th>
              <th>长任务</th>
            </tr>
          </thead>
          <tbody>
            {opens.length === 0 && (
              <tr>
                <td colSpan={6} className={styles.dim}>
                  还没有样本
                </td>
              </tr>
            )}
            {opens.map((open) => (
              <tr key={open.id}>
                <td className={styles.ellipsis}>{open.label}</td>
                <td>{open.cold ? '冷' : '热'}</td>
                <td className={open.paint !== null && open.paint > 150 ? styles.bad : ''}>{fmt(open.paint, 0)}</td>
                <td>{fmt(open.sync)}</td>
                <td>{fmt(open.cover, 0)}</td>
                <td>{open.longTaskMs > 50 ? <span className={styles.bad}>{open.longTaskMs}</span> : open.longTaskMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.mono}>最大帧间隔 {opens[0] ? fmt(opens[0].maxGapMs) : '—'} ms · 慢帧 {opens[0]?.slowFrames ?? 0}</div>
      </section>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>长任务（最近）</span>
          <b>{tasks.length}</b>
        </div>
        <div className={styles.mono}>
          {tasks.length === 0 && '无'}
          {tasks.map((task, i) => (
            <div key={`${task.start}-${i}`} className={task.duration > 50 ? styles.bad : ''}>
              {task.duration.toFixed(0)}ms {task.name.slice(0, 42)}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>折射玻璃面</span>
          <b>
            {surfaces.full} 块 / {(surfaces.area / 1000).toFixed(0)}k px²
          </b>
        </div>
        <div className={styles.mono}>
          maxDisplacement {glassStats.maxDisplacement}px · 重建 {glassStats.builds} 次 · 最近 {glassStats.lastBuildMs}ms
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.row}>
          <span>后台任务</span>
          <b>{analysis.active ? `${analysis.stage} ${analysis.done}/${analysis.total}` : scan.active ? '扫描中' : '空闲'}</b>
        </div>
        <div className={styles.mono}>
          分析并发 {analysis.workers} · 分轨 {main?.stems.active ? `${main.stems.stage} ${main.stems.percent}%` : '空闲'} · 输入空闲{' '}
          {main ? Math.round(main.inputIdleMs) : '—'}ms
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.mono}>
          {main ? `${main.gpu.vendor} ${main.gpu.device}` : 'GPU …'} · {main ? main.gpu.feature : '—'}
        </div>
        <div className={styles.mono}>
          {main ? `${main.display.width}x${main.display.height} @ ${main.display.refresh}Hz · DPR ${main.display.scale}` : '显示器 …'} · 核 {main?.cores ?? '—'} · 内存{' '}
          {main ? `${main.memoryMb}MB` : '—'} · 网桥 {netConnected ? '已连' : '未连'}
        </div>
        {main && !main.gpu.accelerated && <div className={styles.bad}>GPU 未硬件加速</div>}
      </section>
    </div>
  )
}
