import type { JSX } from 'react'
import { Icon } from '../components/Icon'
import { bridge } from '../bridge'
import { useStore } from '../state/store'
import styles from '../components/views.module.css'

export function EmptyState(): JSX.Element {
  const setDragActive = useStore((s) => s.setDragActive)
  return (
    <div className={styles.empty}>
      <div className={styles.emptyArt}>
        <Icon name="music" size={44} />
      </div>
      <div className={styles.emptyTitle}>添加你的音乐</div>
      <div className={styles.emptyText}>
        选择一个音乐文件夹，Pineapple Music 会在后台读取标签、封面与歌词，并把节拍分析准备好。扫描过程中已入库的歌曲可以立即播放。
      </div>
      <button type="button" className={styles.primaryButton} onClick={() => void bridge.pickFolder()}>
        <Icon name="folderPlus" size={15} />
        选择文件夹…
      </button>
      <div
        className={styles.emptyText}
        style={{ marginTop: 4 }}
        onPointerEnter={() => setDragActive(false)}
      >
        也可以把文件夹或音频文件直接拖进窗口
      </div>
    </div>
  )
}
