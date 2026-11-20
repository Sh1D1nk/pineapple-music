import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import styles from './VirtualGrid.module.css'

interface Props<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  estimate: number
  gap?: number
}

/** 单列虚拟列表（艺人行、搜索结果等）：只挂可见的十几行。 */
export function VirtualList<T>({ items, renderItem, estimate, gap = 0 }: Props<T>): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState(0)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const scroll = document.getElementById('contentScroll')
    const measure = (): void => {
      if (!scroll) return
      const hostRect = host.getBoundingClientRect()
      const scrollRect = scroll.getBoundingClientRect()
      setTop(hostRect.top - scrollRect.top + scroll.scrollTop)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (typeof document === 'undefined' ? null : document.getElementById('contentScroll')),
    estimateSize: () => estimate + gap,
    overscan: 4,
    scrollMargin: top
  })

  return (
    <div ref={hostRef} className={styles.host}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
          >
            {renderItem(items[row.index]!, row.index)}
          </div>
        ))}
      </div>
    </div>
  )
}
