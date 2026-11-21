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
        选择一个文件夹。Pinnet 会读取标签、封面与歌词；已入库的歌曲可立即播放。
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
        或将文件夹拖入窗口
      </div>
    </div>
  )
}
