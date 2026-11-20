import { useRef, useState, type JSX } from 'react'
import { frameBudgetMs, frameSummary } from '../perf/core'
import { glassStats } from '../glass/stats'
import { springTo, type SpringHandle } from '../lib/spring'
import styles from './GlassLab.module.css'

type Mode = 'full' | 'lite' | 'off'

interface SampleProps {
  title: string
  size: string
  className?: string
  mode: Mode
  onMode: (mode: Mode) => void
  children?: React.ReactNode
}

function Sample({ title, size, className, mode, onMode, children }: SampleProps): JSX.Element {
  const surfaceClass = mode === 'full' ? 'glass glassFull' : mode === 'lite' ? 'glass glassLite' : 'glass'
  return (
    <div className={styles.sample}>
      <div className={styles.sampleHead}>
        <div>
          <div className={styles.sampleTitle}>{title}</div>
          <div className={styles.sampleSize}>{size}</div>
        </div>
        <div className={styles.modes}>
          {(['full', 'lite', 'off'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              className={mode === entry ? styles.modeOn : styles.modeOff}
              onClick={() => onMode(entry)}
            >
              {entry === 'full' ? '完整折射' : entry === 'lite' ? '简化' : '关闭'}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.stage}>
        <div
          className={`${surfaceClass} ${styles.surface} ${className ?? ''}`}
          data-sample-mode={mode}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * 玻璃实验室（Ctrl+Shift+G）。
 * 背景刻意做成高对比网格 + 文字 + 渐变 + 封面墙：只有在「有内容从玻璃下面穿过」时，
 * 折射才看得出来；纯色背景上的玻璃永远像一块磨砂贴纸。
 */
export function GlassLab(): JSX.Element {
  const [capsuleMode, setCapsuleMode] = useState<Mode>('full')
  const [roundMode, setRoundMode] = useState<Mode>('full')
  const [panelMode, setPanelMode] = useState<Mode>('full')
  const [sideMode, setSideMode] = useState<Mode>('lite')
  const [pressMode, setPressMode] = useState<Mode>('full')
  const pressRef = useRef<HTMLDivElement>(null)
  const springRef = useRef<SpringHandle | null>(null)
  const [press, setPress] = useState(0)
  const [measured, setMeasured] = useState<{ p50: number; p95: number } | null>(null)
  const frames = frameSummary()

  const runPress = (target: number): void => {
    springRef.current?.stop()
    springRef.current = springTo(press, target, (value) => {
      setPress(value)
      const el = pressRef.current
      if (!el) return
      const w = el.offsetWidth || 240
      el.style.transform = `scale(${1 + (16 / w) * value})`
    })
  }

  const measure = (): void => {
    const samples: number[] = []
    let last = performance.now()
    let frames = 0
    const tick = (now: number): void => {
      samples.push(now - last)
      last = now
      frames++
      if (frames < 90) requestAnimationFrame(tick)
      else {
        const sorted = [...samples].sort((a, b) => a - b)
        setMeasured({
          p50: Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10,
          p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10
        })
      }
    }
    requestAnimationFrame(tick)
  }

  return (
    <div className={styles.page}>
      {/* 背景：高对比网格 + 文字 + 渐变 + 封面墙 */}
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.grid} />
        <div className={styles.texture}>
          {Array.from({ length: 30 }).map((_, i) => (
            <span key={i}>
              Liquid Glass / 液态玻璃 · 边缘折射必须让背景线条弯折，中心保持清晰 · 0123456789
            </span>
          ))}
        </div>
        <div className={styles.blobA} />
        <div className={styles.blobB} />
        <div className={styles.coverWall}>
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className={styles.coverTile} style={{ filter: `hue-rotate(${i * 17}deg)` }} />
          ))}
        </div>
      </div>

      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className="pageTitle">玻璃实验室</h1>
          <p className="pageSubtitle">
            帧预算 {frameBudgetMs().toFixed(1)}ms · 当前 p50 {frames.p50.toFixed(1)} / p95 {frames.p95.toFixed(1)} ·
            位移上限 {glassStats.maxDisplacement}px · 重建 {glassStats.builds} 次
          </p>
          <div className={styles.headerActions}>
            <button type="button" className={styles.button} onClick={measure}>
              测 1.5 秒帧耗时
            </button>
            {measured && (
              <span className={styles.measure}>
                p50 {measured.p50}ms · p95 {measured.p95}ms
              </span>
            )}
          </div>
        </header>

        <div className={styles.grid2}>
          <Sample title="64px 胶囊" size="底栏播放器" mode={capsuleMode} onMode={setCapsuleMode}>
            <div className={styles.demoCapsule}>
              <span className={styles.demoCover} />
              <span className={styles.demoMeta}>
                <b>Liquid Glass</b>
                <i>边缘 16px 折射 · 中心清晰</i>
              </span>
              <span className={styles.demoPlay}>▶</span>
            </div>
          </Sample>

          <Sample title="48px 圆按钮" size="歌词 / 待播清单" mode={roundMode} onMode={setRoundMode}>
            <div className={styles.demoRound}>♪</div>
          </Sample>

          <Sample title="360 × 480 面板" size="弹出层 / 信息卡" mode={panelMode} onMode={setPanelMode}>
            <div className={styles.demoPanel}>
              <b>面板玻璃</b>
              <span>面板面积大，按预算使用 CSS 磨砂 + 高光描边，不做位移折射。</span>
            </div>
          </Sample>

          <Sample title="248 × 700 大侧栏" size="导航 / 队列" mode={sideMode} onMode={setSideMode}>
            <div className={styles.demoSide}>
              {['最近添加', '艺人', '专辑', '歌曲', '收藏'].map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </Sample>

          <Sample title="按下缩放" size="(宽+16)/宽 · ζ=0.5 · k=300" mode={pressMode} onMode={setPressMode}>
            <div
              ref={pressRef}
              className={styles.demoPress}
              onPointerDown={() => runPress(1)}
              onPointerUp={() => runPress(0)}
              onPointerLeave={() => runPress(0)}
            >
              按住我
            </div>
          </Sample>
        </div>

        <p className={styles.note}>
          验收：在高对比网格上截图，「玻璃开」与「玻璃关」的边缘带差异像素 ≥ 30%，中心区域差异很小。
          自动检查见 <code>npm run test:glass</code>。
        </p>
      </div>
    </div>
  )
}
