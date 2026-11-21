import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { Cover } from '../components/Cover'
import { albumKeyOf } from '../lib/group'
import { coverUrl } from '../bridge'
import styles from './CoverFlowView.module.css'

interface FlowItem {
  key: string
  title: string
  artist: string
  coverId: string | null
  songIds: string[]
}

/** 对齐 lucadenhez/coverflow（Matt Doyle 2011）：固定 65°，800ms 强缓动，无缩放，当前项额外留白。 */
const SIDE_ANGLE = 65
const TRANSITION = 'transform 800ms cubic-bezier(0, 0, 0.001, 1)'
const MAX_VISIBLE = 6
const SWIPE_X = 30
const SWIPE_Y = 90

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

/**
 * Cover Flow，按参考项目的运动模型实现：
 *  - 每张的 transform 只由「与当前项的距离」决定；输入只改变当前项，由 CSS 在 800ms 内插值
 *  - 当前项 rotateY(0) 放在正中；两侧固定 rotateY(±65°)，靠 translateZ 后退
 *  - 当前项左右各留一大段 padding，侧封面之间只隔一小步，形成层叠的侧面
 *  - 滚轮/滑动/方向键一次只走一张；没有队列、没有逐格停顿
 */
export function CoverFlowView(): JSX.Element {
  const songs = useStore((s) => s.songs)
  const playSongs = useStore((s) => s.playSongs)

  const items = useMemo<FlowItem[]>(() => {
    const map = new Map<string, FlowItem>()
    for (const song of Object.values(songs)) {
      const key = albumKeyOf(song)
      const existing = map.get(key)
      if (existing) {
        existing.songIds.push(song.id)
        continue
      }
      map.set(key, {
        key,
        title: song.album || song.title,
        artist: song.artists[0] ?? song.albumArtist,
        coverId: song.coverId,
        songIds: [song.id]
      })
    }
    return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  }, [songs])

  const initial = useMemo(() => {
    const state = useStore.getState()
    const id = state.playback.queue[state.playback.index]?.songId
    const song = id ? state.songs[id] : undefined
    const found = song ? items.findIndex((item) => item.key === albumKeyOf(song)) : -1
    return found >= 0 ? found : Math.floor(items.length / 2)
  }, [items])

  const [index, setIndex] = useState(initial)
  const [size, setSize] = useState(340)
  const [stageH, setStageH] = useState(500)
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef(initial)
  /** 上一次指针交互是滑动：用来吞掉浏览器补发的 click，直到下一次 pointerdown */
  const swipedRef = useRef(false)
  const swipeRef = useRef({ x: 0, y: 0, pointerId: -1 })
  const maxIndex = Math.max(0, items.length - 1)

  useEffect(() => {
    indexRef.current = index
  }, [index])

  useEffect(() => {
    if (items.length === 0) return
    const next = clamp(indexRef.current, 0, Math.max(0, items.length - 1))
    if (next !== indexRef.current) {
      indexRef.current = next
      setIndex(next)
    }
  }, [items.length])

  // 尺寸：参考项目用 windowHeight-150 作为封面高度，这里按舞台高度等比缩放
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const measure = (): void => {
      const w = stage.clientWidth
      const h = stage.clientHeight
      setStageH(h)
      setSize(Math.round(clamp(Math.min(h * 0.66, w * 0.34), 220, 430)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  // 相邻封面提前备好 640，翻到正中时不会先糊一下
  useEffect(() => {
    for (const offset of [index - 1, index + 1]) {
      const cover = items[offset]?.coverId
      if (!cover) continue
      const url = coverUrl(cover, 640)
      if (!url) continue
      const img = new Image()
      img.src = url
      void img.decode?.().catch(() => undefined)
    }
  }, [index, items])

  const go = (delta: number): void => {
    setIndex((value) => clamp(value + delta, 0, maxIndex))
  }

  const goTo = (target: number): void => {
    if (target === index) {
      const item = items[target]
      if (item) playSongs(item.songIds, 0)
      return
    }
    setIndex(clamp(target, 0, maxIndex))
  }

  // 滚轮：一次事件一张（参考项目同一模型），75ms 内合并同一次触控板惯性
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const raw = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (raw === 0) return
      // 参考项目：一个 wheel 事件 = 一张，不做累积、不做停顿
      go(raw > 0 ? 1 : -1)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxIndex])

  // 滑动（参考项目的 jswipe 阈值：水平 30px，垂直 90px）
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    swipedRef.current = false
    swipeRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    setDragging(true)
  }

  useEffect(() => {
    const finish = (event: PointerEvent): void => {
      const swipe = swipeRef.current
      if (swipe.pointerId !== event.pointerId) return
      swipe.pointerId = -1
      setDragging(false)
      const dx = event.clientX - swipe.x
      const dy = event.clientY - swipe.y
      if (Math.abs(dx) >= SWIPE_X && Math.abs(dy) <= SWIPE_Y) {
        // 滑动结束后浏览器会补一个 click（落点上的封面），别让它再跳一张
        swipedRef.current = true
        go(dx < 0 ? 1 : -1)
      }
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxIndex])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      go(1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      go(-1)
    } else if (event.key === 'Enter' && items[index]) {
      event.preventDefault()
      playSongs(items[index]!.songIds, 0)
    }
  }

  const current = items[index]
  // 参考项目比例：当前项左右 padding ≈ 0.9 个封面宽，侧封面之间只隔 0.13 个舞台高
  const padding = size * 0.9
  const step = stageH * 0.16
  const visible: { item: FlowItem; i: number }[] = []
  const from = Math.max(0, index - MAX_VISIBLE)
  const to = Math.min(items.length - 1, index + MAX_VISIBLE)
  for (let i = from; i <= to; i++) {
    const item = items[i]
    if (item) visible.push({ item, i })
  }

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1 className={styles.title}>Cover Flow</h1>
        <span className={styles.count}>{items.length > 0 ? `${index + 1} / ${items.length}` : '0 张专辑'}</span>
      </header>

      <div
        ref={stageRef}
        className={`${styles.stage} ${dragging ? styles.stageDragging : ''}`}
        tabIndex={0}
        role="listbox"
        aria-label="Cover Flow"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <div className={styles.rail}>
          {visible.map(({ item, i }) => {
            const d = i - index
            const dir = Math.sign(d)
            const abs = Math.abs(d)
            const center = d === 0
            const x = center ? 0 : dir * (size * 0.5 + padding + (abs - 1) * step)
            const z = center ? 0 : -(100 + size / 1.5)
            const angle = center ? 0 : -dir * SIDE_ANGLE
            return (
              <button
                key={item.key}
                type="button"
                className={styles.item}
                data-center={center ? 'true' : 'false'}
                data-cf-index={i}
                style={{
                  top: `calc(50% - ${Math.round(size * 0.26)}px)`,
                  transform: `translate(-50%, -50%) translateX(${x}px) translateZ(${z}px) rotateY(${angle}deg)`,
                  transition: TRANSITION,
                  zIndex: center ? 100 : -100,
                  opacity: 1
                }}
                onClick={() => {
                  if (swipedRef.current) return
                  goTo(i)
                }}
                title={`${item.title} — ${item.artist}`}
              >
                <span
                  className={`${styles.art} ${center ? styles.artCenter : ''} `}
                  style={{ width: size, height: size }}
                  data-cf-art="1"
                >
                  {item.coverId ? (
                    <Cover
                      coverId={item.coverId}
                      size={abs <= 1 ? 640 : 240}
                      radius={6}
                      alt={item.title}
                      priority={abs <= 1}
                    />
                  ) : (
                    <span className={styles.fallback} style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}>
                      {item.title.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                {center && (
                  <span
                    className={styles.reflection}
                    aria-hidden="true"
                    style={{
                      height: Math.round(size * 0.26),
                      backgroundImage: item.coverId ? `url(${coverUrl(item.coverId, 240)})` : undefined
                    }}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className={styles.caption}>
        <div className={styles.captionTitle} key={current?.key ?? 'empty'}>
          {current?.title ?? '暂无专辑'}
        </div>
        <div className={styles.captionArtist}>{current?.artist ?? ''}</div>
      </div>
    </div>
  )
}
