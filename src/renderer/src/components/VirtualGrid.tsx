import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import styles from './VirtualGrid.module.css'

interface Props<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  /** 单列最小宽度（与原 grid 的 minmax 保持一致） */
  min?: number
  gap?: number
  /** 网格顶边到滚动容器顶边的额外偏移（页头高度），自动测量，一般不用传 */
  offset?: number
}

/**
 * 固定尺寸的虚拟化网格。
 *
 * 之前专辑页一次渲染 1500+ 张卡片：每张卡都带 Cover（两个 DOM + 一个 img + 三个 state），
 * 打开页面要创建上万节点 —— 这就是「点专辑要等半秒」的元凶。
 * 现在只挂可见的两三行，滚动时按需替换；卡片尺寸固定，滚动位置稳定。
 */
export function VirtualGrid<T>({ items, renderItem, min = 190, gap = 24, offset = 0 }: Props<T>): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [cols, setCols] = useState(4)
  const [colW, setColW] = useState(min)
  const [top, setTop] = useState(offset)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const scroll = document.getElementById('contentScroll')
    const measure = (): void => {
      const width = host.clientWidth || 800
      const nextCols = Math.max(1, Math.floor((width + gap) / (min + gap)))
      setCols(nextCols)
      setColW(Math.max(80, (width - gap * (nextCols - 1)) / nextCols))
      if (scroll) {
        const hostRect = host.getBoundingClientRect()
        const scrollRect = scroll.getBoundingClientRect()
        setTop(hostRect.top - scrollRect.top + scroll.scrollTop)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    // 页面保活用 visibility 隐藏：尺寸不变，ResizeObserver 不会触发。
    // 但隐藏期间量到的 top / 列宽可能是过渡态，切回来必须重算一次，
    // 否则首行会停在半空（看起来像一块莫名其妙的空白）。
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestAnimationFrame(measure)
      },
      { threshold: 0.01 }
    )
    io.observe(host)
    return () => {
      ro.disconnect()
      io.disconnect()
    }
  }, [gap, min])

  const rows = Math.ceil(items.length / cols)
  const rowHeight = Math.round(colW) + 8 + 44 + gap
  const scroll = typeof document === 'undefined' ? null : document.getElementById('contentScroll')

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroll,
    estimateSize: () => rowHeight,
    overscan: 1,
    scrollMargin: top
  })

  useLayoutEffect(() => {
    virtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight, cols, top])

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <div ref={hostRef} className={styles.host}>
      {/* scrollMargin 已经包含在 row.start 里；容器本身就在 host 位置，
          所以行偏移要减掉它，高度也要减掉它，否则整块网格会被推下去两次。 */}
      <div style={{ height: Math.max(0, virtualizer.getTotalSize() - top), position: 'relative' }}>
        {virtualRows.map((virtualRow) => {
          const start = virtualRow.index * cols
          const rowItems = items.slice(start, start + cols)
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={styles.row}
              style={{
                transform: `translateY(${virtualRow.start - top}px)`,
                gridTemplateColumns: `repeat(${cols}, ${Math.round(colW)}px)`,
                columnGap: gap
              }}
            >
              {rowItems.map((item, i) => (
                <div key={start + i} className={styles.cell}>
                  {renderItem(item, start + i)}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
