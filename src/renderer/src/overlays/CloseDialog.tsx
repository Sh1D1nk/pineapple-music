import { useEffect, useRef, useState, type JSX } from 'react'
import { loadHyalite } from '../glass/hyalite'
import styles from './overlay.module.css'

/**
 * 关闭主窗口时的确认框 —— 版式照 macOS 的 alert：
 * 标题 + 一行说明 + 记住勾选 + 右下角横排按钮（取消 / 后台播放 / 退出）。
 * 不用原生 dialog.showMessageBox：那个没法做圆角玻璃。
 */
export function CloseDialog({ dark }: { dark: boolean }): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.overlay = '1'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    let disposed = false
    let detach: (() => void) | null = null
    void loadHyalite().then((api) => {
      const el = cardRef.current
      if (disposed || !api || !el) return
      api.attach(el, {
        bevel: 16,
        thickness: 30,
        dispersion: 1,
        blur: 2,
        slope: 2.4,
        sat: 0.95,
        shade: 0.28,
        rim: 1.5,
        edgeW: 5,
        light: -140,
        materialize: 150
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
      delete document.documentElement.dataset.overlay
    }
  }, [dark])

  const decide = (action: 'background' | 'quit' | 'cancel'): void => {
    window.lm.send('overlay/close-decision', { action, remember: action === 'cancel' ? false : remember })
  }

  return (
    <div className={styles.shell}>
      <div ref={cardRef} className={`${styles.card} ${styles.alert}`}>
        <div className={styles.alertTitle}>关闭 Pineapple Music？</div>
        <div className={styles.alertBody}>音乐可以继续在后台播放，也可以直接退出。</div>

        <label className={styles.alertRemember} onClick={() => setRemember((v) => !v)}>
          <span className={styles.checkbox} data-on={remember ? 'true' : 'false'}>
            ✓
          </span>
          记住我的选择
        </label>

        <div className={styles.alertActions}>
          <button type="button" className={styles.alertButton} onClick={() => decide('cancel')}>
            取消
          </button>
          <button
            type="button"
            className={`${styles.alertButton} ${styles.alertPrimary}`}
            onClick={() => decide('background')}
          >
            后台播放
          </button>
          <button
            type="button"
            className={`${styles.alertButton} ${styles.rowDanger}`}
            onClick={() => decide('quit')}
          >
            退出
          </button>
        </div>
      </div>
    </div>
  )
}
