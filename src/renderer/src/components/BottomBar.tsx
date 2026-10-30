import type { JSX } from 'react'
import { Icon, type IconName } from './Icon'
import { useStore } from '../state/store'
import styles from './BottomBar.module.css'

/**
 * 底部导航（液态玻璃主题专用）。
 *
 * 版式与视觉严格按 iOS 26 Liquid Glass / Human Interface Guidelines：
 *   - 一条悬浮的玻璃胶囊，位于内容之上、屏幕底部安全区上方；
 *   - 每个 Tab 为「图标 + 10pt 标签」竖排，选中项用同色系的浅色胶囊底；
 *   - 材质 = 半透明底 + 背景实时模糊 + 饱和度增强；边缘只有顶部 1px 镜面高光与 0.5pt 内描边；
 *   - 大圆角（连续曲率观感）、柔和悬浮投影；
 *   - 不添加任何额外装饰（光斑、动效光带、渐变条纹都不属于规范）。
 *
 * 导航项与桌面侧边栏完全一致：五个资料库分区 + 设置；随机推荐作为独立玻璃胶囊挂在右侧，
 * 它是动作而非页面（和侧边栏同一个取舍）。
 */

const NAV: {
  key: 'recent' | 'artists' | 'albums' | 'songs' | 'favorites'
  label: string
  icon: IconName
}[] = [
  { key: 'recent', label: '最近添加', icon: 'clock' },
  { key: 'artists', label: '艺人', icon: 'mic' },
  { key: 'albums', label: '专辑', icon: 'disc' },
  { key: 'songs', label: '歌曲', icon: 'music' },
  { key: 'favorites', label: '收藏', icon: 'star' }
]

export function BottomBar(): JSX.Element {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setSearch = useStore((s) => s.setSearch)
  const songIds = useStore((s) => s.songIds)
  const playRandom = useStore((s) => s.playRandom)
  const pushToast = useStore((s) => s.pushToast)

  const onRandom = (): void => {
    if (songIds.length === 0) {
      pushToast('曲库还是空的，先添加一些音乐吧')
      return
    }
    playRandom()
  }

  return (
    <nav className={styles.dock} aria-label="资料库导航">
      <div className={styles.bar}>
        {NAV.map((entry) => {
          const active = view.kind === entry.key || (entry.key === 'recent' && view.kind === 'album')
          return (
            <button
              key={entry.key}
              type="button"
              data-nav={entry.key}
              data-active={active}
              className={styles.item}
              onClick={() => {
                setSearch('')
                setView({ kind: entry.key } as never)
              }}
              title={entry.label}
            >
              <Icon name={entry.icon} size={22} />
              <span className={styles.label}>{entry.label}</span>
            </button>
          )
        })}

        <span className={styles.separator} aria-hidden="true" />

        <button
          type="button"
          data-nav="settings"
          data-active={view.kind === 'settings'}
          className={styles.item}
          onClick={() => setView({ kind: 'settings' })}
          title="设置"
        >
          <Icon name="gear" size={21} />
          <span className={styles.label}>设置</span>
        </button>
      </div>

      <button
        type="button"
        className={styles.random}
        onClick={onRandom}
        title="随机挑一首歌播放"
        aria-label="随机推荐"
      >
        <Icon name="sparkles" size={20} />
        <span className={styles.label}>随机</span>
      </button>
    </nav>
  )
}
