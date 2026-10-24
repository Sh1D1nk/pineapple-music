import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { Cover } from './Cover'
import { Icon } from './Icon'
import { albumKeyOf } from '../lib/group'
import styles from './CoverFlow.module.css'

interface Props {
  open: boolean
  onClose: () => void
}

interface FlowItem {
  key: string
  title: string
  artist: string
  coverId: string | null
  songIds: string[]
}

/**
 * iPod 风格 Cover Flow：专辑封面在透视空间里排成一条流。
 *
 * - 拖拽：指针位移直接换算成索引位移，松手后按速度滑行并吸附到最近的一张；
 * - 滚轮：一次滚一格（带阈值，避免触控板一滑飞出去）；
 * - 中间的封面是正脸，两侧按距离做 Y 轴旋转与后退，形成经典的 Cover Flow 透视；
 * - 点任意一张封面 → 播放该专辑，与队列、歌词面板、进度条共用同一套播放状态。
 */
export function CoverFlow({ open, onClose }: Props): JSX.Element | null {
  const songs = useStore((s) => s.songs)
  const playSongs = useStore((s) => s.playSongs)
  const [pos, setPos] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef({ startX: 0, startPos: 0, lastX: 0, lastT: 0, velocity: 0 })
  const railRef = useRef<HTMLDivElement>(null)

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

  // 打开时停在当前播放歌曲的专辑上；没有在播放就停在列表中间
  useEffect(() => {
    if (!open) return
    const currentId = useStore.getState().playback.queue[useStore.getState().playback.index]?.songId
    const currentSong = currentId ? useStore.getState().songs[currentId] : undefined
    const index = currentSong ? items.findIndex((item) => item.key === albumKeyOf(currentSong)) : -1
    setPos(index >= 0 ? index : Math.floor(items.length / 2))
  }, [open, items])

  // Esc 关闭封面流
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 滚轮：一次一格
  useEffect(() => {
    if (!open) return undefined
    let acc = 0
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      acc += event.deltaY
      if (Math.abs(acc) < 24) return
      const step = acc > 0 ? 1 : -1
      acc = 0
      setPos((value) => Math.max(0, Math.min(items.length - 1, Math.round(value) + step)))
    }
    const node = railRef.current
    node?.addEventListener('wheel', onWheel, { passive: false })
    return () => node?.removeEventListener('wheel', onWheel)
  }, [open, items.length])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    drag.current = {
      startX: event.clientX,
      startPos: pos,
      lastX: event.clientX,
      lastT: performance.now(),
      velocity: 0
    }
  }, [pos])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const state = drag.current
    const spacing = railRef.current?.clientWidth ? Math.max(120, railRef.current.clientWidth * 0.22) : 220
    const next = state.startPos - (event.clientX - state.startX) / spacing
    const now = performance.now()
    const dt = Math.max(1, now - state.lastT)
    state.velocity = (state.lastX - event.clientX) / dt
    state.lastX = event.clientX
    state.lastT = now
    setPos(Math.max(-1, Math.min(items.length, next)))
  }, [dragging, items.length])

  const onPointerUp = useCallback((): void => {
    if (!dragging) return
    setDragging(false)
    // 松手后按速度滑行，再吸附到最近的一张
    const glide = drag.current.velocity * 180
    setPos((value) => {
      const target = Math.round(value + glide)
      return Math.max(0, Math.min(items.length - 1, target))
    })
  }, [dragging, items.length])

  const play = useCallback((item: FlowItem): void => {
    playSongs(item.songIds, 0)
  }, [playSongs])

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.stage} onClick={(event) => event.stopPropagation()}>
        <div
          ref={railRef}
          className={`${styles.rail} ${dragging ? styles.dragging : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {items.map((item, index) => {
            const d = index - pos
            if (Math.abs(d) > 7) return null
            return (
              <button
                key={item.key}
                type="button"
                className={styles.cover}
                style={{
                  transform: `translate3d(${d * 210}px, 0, ${-Math.abs(d) * 120}px) rotateY(${
                    Math.max(-1, Math.min(1, d)) * -58
                  }deg) scale(${1 - Math.min(1, Math.abs(d) * 0.18)})`,
                  opacity: 1 - Math.min(0.85, Math.abs(d) * 0.22),
                  zIndex: 100 - Math.round(Math.abs(d) * 10)
                }}
                onClick={() => {
                  if (Math.abs(d) > 0.6) {
                    setPos(index)
                    return
                  }
                  play(item)
                  onClose()
                }}
                title={`${item.title} — ${item.artist}`}
              >
                <Cover coverId={item.coverId} size={640} radius={0} alt={item.title} />
                <span className={styles.caption}>
                  <span className={styles.captionTitle}>{item.title}</span>
                  <span className={styles.captionArtist}>{item.artist}</span>
                </span>
              </button>
            )
          })}
        </div>
        <button type="button" className={styles.close} onClick={onClose} title="关闭 (Esc)">
          <Icon name="close" size={20} />
        </button>
        <div className={styles.hint}>拖拽或滚轮切换封面 · 点击中间封面开始播放</div>
      </div>
    </div>
  )
}
