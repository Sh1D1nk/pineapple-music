import type { JSX } from 'react'
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
  const style: React.CSSProperties = {
    borderRadius: radius !== undefined ? `${radius}px` : undefined,
    width: display !== undefined ? `${display}px` : undefined,
    height: display !== undefined ? `${display}px` : undefined
  }
  if (!url) {
    return (
      <div className={`${styles.cover} ${styles.placeholder} ${className ?? ''}`} style={style} aria-label="无封面">
        <Icon name="music" size={display ? Math.max(14, Math.round(display * 0.34)) : 20} />
      </div>
    )
  }
  return (
    <img
      className={`${styles.cover} ${className ?? ''}`}
      style={style}
      src={url}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
    />
  )
}
