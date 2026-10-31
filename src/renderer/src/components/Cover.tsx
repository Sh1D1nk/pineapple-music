import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
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
  /** 首屏可见的封面：立即发起加载，别等懒加载的可见性判定（那会晚 100ms+） */
  priority?: boolean
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
export function Cover({ coverId, size, display, radius, className, alt = '', priority = false }: Props): JSX.Element {
  const url = coverUrl(coverId, size)
  // 封面文件是异步落盘的：图片没就绪时先垫一张占位图，加载成功后淡入。
  // 这样无论是「暂停」还是「刚入库」，都不会出现一个空白方框。
  const [ready, setReady] = useState(false)
  /** 命中缓存时不做淡入：列表返回的一瞬间就该是成品画面，而不是「再加载一次」 */
  const [instant, setInstant] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    setReady(false)
  }, [url])
  // 列表页返回时会整页重新挂载，封面元素也是新的：如果图片已在浏览器缓存里
  // （complete && naturalWidth），就在首次绘制前直接置为就绪。
  // 否则会先画一帧灰色占位、再淡入，看起来就是「整页重新加载了一次」。
  useLayoutEffect(() => {
    const el = imgRef.current
    if (el && el.complete && el.naturalWidth > 0) {
      setInstant(true)
      setReady(true)
    }
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
          ref={imgRef}
          className={`${styles.coverImage} ${ready ? styles.coverReady : ''} ${instant ? styles.coverInstant : ''}`}
          src={url}
          alt={alt}
          draggable={false}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          // 液态玻璃的 backdrop 会把这张图重绘进 canvas 当折射源；
          // 不声明 crossOrigin 的跨源图会污染 canvas，纹理上传直接抛 SecurityError。
          // amcover:// 协议已返回 Access-Control-Allow-Origin: *，同源/data: 图不受影响。
          crossOrigin="anonymous"
          onLoad={() => setReady(true)}
          onError={() => setReady(false)}
        />
      )}
    </div>
  )
}
