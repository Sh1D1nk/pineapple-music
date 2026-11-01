import { useEffect } from 'react'
import { useStore } from '../state/store'

/**
 * 主窗口 ↔ 主进程的播放状态桥：
 *   - 播放状态变化时上报（托盘菜单靠它显示曲目/按钮状态）
 *   - 接收托盘菜单的音量命令
 */
export function useTrayBridge(): void {
  const playing = useStore((s) => s.playback.playing)
  const volume = useStore((s) => s.playback.volume)
  const songId = useStore((s) => s.playback.queue[s.playback.index]?.songId)
  const hasTrack = Boolean(songId)
  const title = useStore((s) => (songId ? s.songs[songId]?.title ?? '' : ''))
  const artist = useStore((s) => (songId ? (s.songs[songId]?.artists ?? []).join(' / ') : ''))
  const coverId = useStore((s) => (songId ? s.songs[songId]?.coverId ?? null : null))

  useEffect(() => {
    window.lm.send('media/state', { playing, hasTrack, title, artist, volume, coverId })
  }, [playing, hasTrack, title, artist, volume, coverId])

  useEffect(() => {
    return window.lm.on('media/volume', ((value: number) => {
      useStore.getState().setVolume(value)
    }) as never)
  }, [])
}
