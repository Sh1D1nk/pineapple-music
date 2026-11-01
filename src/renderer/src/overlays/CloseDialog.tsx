import { useEffect, useRef, useState, type JSX } from 'react'
import { loadHyalite } from '../glass/hyalite'
import styles from './overlay.module.css'

/**
 * 关闭主窗口时的确认框（无边框透明窗口 + 液态玻璃）。
 * 选择通过 IPC 回传主进程；「记住」由主进程写进 settings.closeBehavior。
 */
export function CloseDialog({ dark }: { dark: boolean }): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    let disposed = false
    let detach: (() => void) | null = null
    void loadHyalite().then((api) => {
      const el = cardRef.current
      if (disposed || !api || !el) return
      api.attach(el, {
        bevel: 20,
        thickness: 34,
        dispersion: 1.1,
        blur: 2,
        slope: 2.4,
        sat: 0.95,
        shade: 0.3,
        rim: 1.6,
        edgeW: 6,
        light: -140,
        materialize: 160
      })
      detach = () => {
        try {
          api.detach(el)
        } catch {
          /* ignore */
        }
        el.style.removeProperty('--hyalite')
        el.style.removeProperty('--hyalite-edge')
      }
    })
    return () => {
      disposed = true
      detach?.()
    }
  }, [dark])

  const decide = (action: 'background' | 'quit' | 'cancel'): void => {
    window.lm.send('overlay/close-decision', { action, remember: action === 'cancel' ? false : remember })
  }

  return (
    <div className={styles.shell}>
      <div ref={cardRef} className={styles.card}>
        <div className={styles.title}>关闭 Pineapple Music？</div>
        <div className={styles.body}>
          选「在后台继续播放」窗口会收起，音乐不停，托盘图标留在系统里；选「直接关闭」就退出播放。
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => decide('background')}>
            在后台继续播放
          </button>
          <button type="button" className={styles.secondary} onClick={() => decide('quit')}>
            直接关闭
          </button>
        </div>
        <label className={styles.remember} onClick={() => setRemember((v) => !v)}>
          <span className={styles.checkbox} data-on={remember ? 'true' : 'false'}>
            {remember ? '✓' : ''}
          </span>
          记住我的选择，下次不再询问
        </label>
      </div>
    </div>
  )
}
