import { useState, type JSX } from 'react'
import { useStore } from '../state/store'
import styles from './UpdateNotice.module.css'

const DISMISS_KEY = 'pinnet.update.dismissed'

/**
 * 发现新版本时的轻提示。只做两件事：告诉你版本号、把 GitHub Release 页面打开。
 * 应用不做静默下载 / 自动替换安装包（未签名的 NSIS 走不通，也不该背着用户升级）。
 */
export function UpdateNotice(): JSX.Element | null {
  const update = useStore((s) => s.update)
  const openUpdate = useStore((s) => s.openUpdate)
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) ?? ''
    } catch {
      return ''
    }
  })

  if (!update || !update.hasUpdate || !update.latest) return null
  if (dismissed === update.latest) return null

  const dismiss = (): void => {
    setDismissed(update.latest ?? '')
    try {
      localStorage.setItem(DISMISS_KEY, update.latest ?? '')
    } catch {
      /* ignore */
    }
  }

  return (
    <div className={styles.notice} role="status">
      <div className={styles.text}>
        <div className={styles.title}>
          发现新版本 v{update.latest}
          {update.fake && <span className={styles.fake}>测试数据</span>}
        </div>
        <div className={styles.sub}>
          当前 v{update.current}
          {update.asset ? ` · ${update.asset.name}` : ' · GitHub Releases'}
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void openUpdate()}>
          去 GitHub 更新
        </button>
        <button type="button" className={styles.ghost} onClick={dismiss}>
          稍后
        </button>
      </div>
    </div>
  )
}
