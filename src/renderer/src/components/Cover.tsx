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

export function Cover({ coverId, size, display, radius, className, alt = '' }: Props): JSX.Element {
  const url = coverUrl(coverId, size)
  // 封面文件是异步落盘的：图片没就绪时先垫一张占位图，加载成功后淡入。
  // 这样无论是「暂停」还是「刚入库」，都不会出现一个空白方框。
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
  }, [url])
  const style: React.CSSProperties = {
    borderRadius: radius !== undefined ? `${radius}px` : undefined,
    width: display !== undefined ? `${display}px` : undefined,
    height: display !== undefined ? `${display}px` : undefined
  }
  const placeholder = (
    <div className={`${styles.cover} ${styles.placeholder} ${className ?? ''}`} style={style} aria-label="无封面">
      <Icon name="music" size={display ? Math.max(14, Math.round(display * 0.34)) : 20} />
    </div>
  )
  if (!url) return placeholder
  return (
    <>
      {placeholder}
      <img
        className={`${styles.cover} ${styles.coverImage} ${ready ? styles.coverReady : ''} ${className ?? ''}`}
        style={style}
        src={url}
        alt={alt}
        draggable={false}
        loading="lazy"
        decoding="async"
        onLoad={() => setReady(true)}
        onError={() => setReady(false)}
      />
    </>
  )
}
