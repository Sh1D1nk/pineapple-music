import { useEffect, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { bridge } from '../bridge'
import { formatCount } from '../lib/format'
import styles from './ProgressWidget.module.css'

interface Props {
  count: number
}

export function ProgressWidget({ count }: Props): JSX.Element {
  const analysis = useStore((s) => s.analysis)
  const scan = useStore((s) => s.scan)
  const [open, setOpen] = useState(false)
  const [justFinished, setJustFinished] = useState(false)

  const total = analysis.total || count
  const done = Math.min(analysis.done, total)
  const scanning = scan.active && scan.total > 0
  const analyzing = analysis.active && done < total
  const percent = scanning
    ? Math.round((scan.processed / Math.max(1, scan.total)) * 100)
    : total > 0
      ? Math.round((done / total) * 100)
      : 0
  const active = scanning || analyzing

  useEffect(() => {
    if (!active && total > 0 && done >= total) {
      setJustFinished(true)
      const timer = window.setTimeout(() => setJustFinished(false), 5000)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [active, done, total])

  if (!active && !justFinished && !open) {
    return (
      <div className={styles.wrap}>
        <div className={styles.done}>{formatCount(count)} 首歌曲已就绪</div>
      </div>
    )
  }

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.button} onClick={() => setOpen(!open)}>
        <div className={styles.label}>
          <span>{scanning ? '正在更新资料库' : '正在分析资料库'}</span>
          <strong>
            {percent}%
          </strong>
        </div>
        <div className={styles.track}>
          <div className={styles.fill} style={{ width: `${percent}%` }} />
        </div>
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.panelRow}>
            <span>阶段</span>
            <span>{scanning ? '扫描标签与封面' : '节拍与响度分析'}</span>
          </div>
          <div className={styles.panelRow}>
            <span>已处理</span>
            <span>
              {formatCount(done)} / {formatCount(total)}
            </span>
          </div>
          <div className={styles.panelRow}>
            <span>正在处理</span>
            <span className={styles.ellipsis}>{analysis.currentTitle || scan.currentTitle || '—'}</span>
          </div>
          <div className={styles.panelRow}>
            <span>速度</span>
            <span>
              {analysis.ratePerMin > 0 ? `${analysis.ratePerMin} 首/分钟` : '—'}
              {analysis.etaSec ? ` · 剩余 ${Math.ceil(analysis.etaSec / 60)} 分钟` : ''}
            </span>
          </div>
          <div className={styles.panelRow}>
            <span>AutoMix 分轨</span>
            <span>未安装模型</span>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              onClick={() => void (analysis.paused ? bridge.resumeAnalysis() : bridge.pauseAnalysis())}
            >
              {analysis.paused ? '继续' : '暂停'}
            </button>
            <button type="button" className={styles.action} onClick={() => void bridge.retryAnalysis()}>
              重试失败 ({analysis.failures.length})
            </button>
          </div>
          {analysis.failures.length > 0 && (
            <div className={styles.failures}>
              {analysis.failures.slice(0, 6).map((failure) => (
                <div key={failure.songId} className={styles.failureItem}>
                  {failure.title} — {failure.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
