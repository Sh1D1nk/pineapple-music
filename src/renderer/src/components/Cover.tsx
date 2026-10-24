import { useEffect, useState, type JSX } from 'react'
import { coverUrl } from '../bridge'
import { Icon } from './Icon'
import styles from './Cover.module.css'

interface Props {
  coverId: string | null
  size: 80 | 240 | 640
  display?: number
  radius?: number
  className?: string
  alt?: string
}

/**
 * 封面。
 *
 * 必须在内部带一个定位容器（.frame）：真实封面是 absolute + inset:0，
 * 之前 placeholder 与 img 是**兄弟节点**，img 会绕过所有容器去找祖先里的第一个定位元素
 * （通常是 .contentLayer / .page），于是整张封面铺满内容区。
 * 表现为：艺人页「被大图占满」、专辑页「背景只有一张封面」、
 * 卡片播放按钮「悬浮时消失」（被 z-index 更高的封面盖住）。
 */
export function Cover({ coverId, size, display, radius, className, alt = '' }: Props): JSX.Element {
  const url = coverUrl(coverId, size)
  // 封面文件是异步落盘的：图片没就绪时先垫一张占位图，加载成功后淡入。
  // 这样无论是「暂停」还是「刚入库」，都不会出现一个空白方框。
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
  }, [url])
  const frameStyle: React.CSSProperties = {
    borderRadius: radius !== undefined ? `${radius}px` : undefined,
    width: display !== undefined ? `${display}px` : undefined,
    height: display !== undefined ? `${display}px` : undefined
  }

  return (
    <div className={`${styles.frame} ${className ?? ''}`} style={frameStyle}>
      <div className={styles.placeholder} aria-label={url ? undefined : '无封面'}>
        <Icon name="music" size={display ? Math.max(14, Math.round(display * 0.34)) : 20} />
      </div>
      {url && (
        <img
          className={`${styles.coverImage} ${ready ? styles.coverReady : ''}`}
          src={url}
          alt={alt}
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={() => setReady(true)}
          onError={() => setReady(false)}
        />
      )}
    </div>
  )
}
