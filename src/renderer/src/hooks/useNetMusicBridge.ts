import { useEffect } from 'react'
import { useStore } from '../state/store'
import type { NetSnapshot, NetStatus } from '@shared/netmusic'

/**
 * 订阅主进程的汽水音乐桥：
 *   - netmusic/status：连接状态（决定侧栏是否出现「网络音乐」）
 *   - netmusic/state：歌曲/歌词/播放状态 + 1.5s 进度心跳
 *
 * 心跳只带 position，真实的播放进度由 store 里的 basePositionMs + baseAt 在本地插值，
 * 避免把 60fps 的时间推进交给 IPC。
 */
export function useNetMusicBridge(): void {
  useEffect(() => {
    let disposed = false
    const applySnapshot = (snapshot: NetSnapshot): void => {
      const state = useStore.getState()
      const prev = state.netMusic
      const sameTrack = prev.track?.id === snapshot.track?.id
      const drift = Math.abs((snapshot.positionMs ?? 0) - (prev.basePositionMs ?? 0))
      // 同一首歌、漂移不大时保留本地时钟（避免每次心跳都把画面拽一下）
      const keepClock = sameTrack && !snapshot.playing === !prev.playing && drift < 800 && prev.baseAt > 0
      state.setNetMusic({
        track: snapshot.track,
        lyrics: snapshot.lyrics,
        playing: snapshot.playing,
        durationMs: snapshot.durationMs,
        volume: snapshot.volume,
        muted: snapshot.muted,
        basePositionMs: keepClock ? prev.basePositionMs : snapshot.positionMs,
        baseAt: keepClock ? prev.baseAt : performance.now()
      })
    }

    void window.lm.invoke<{ status: NetStatus; snapshot: NetSnapshot | null }>('netmusic/status').then((res) => {
      if (disposed || !res) return
      useStore.getState().setNetStatus(res.status)
      if (res.snapshot) applySnapshot(res.snapshot)
    })

    const offStatus = window.lm.on('netmusic/status', ((status: NetStatus) => {
      useStore.getState().setNetStatus(status)
      if (!status.connected) {
        // 断开时保留最后一帧画面，只把状态标灰；不把歌词清空（避免闪一下白屏）
        useStore.getState().setNetMusic({ playing: false })
      }
    }) as never)

    const offState = window.lm.on('netmusic/state', ((payload: { snapshot: NetSnapshot }) => {
      if (payload?.snapshot) applySnapshot(payload.snapshot)
    }) as never)

    // 心跳只碰时钟，不碰歌词数组 —— 之前把心跳塞进 state 里，每 1.5s 重建一次
    // 歌词列表，画面就会周期性闪。
    const offBeat = window.lm.on('netmusic/heartbeat', ((hb: { positionMs: number; playing: boolean }) => {
      if (!hb || !Number.isFinite(hb.positionMs)) return
      const st = useStore.getState().netMusic
      const live = st.playing ? st.basePositionMs + (performance.now() - st.baseAt) : st.basePositionMs
      const drift = Math.abs(hb.positionMs - live)
      if (drift > 800) {
        useStore.getState().setNetMusic({ basePositionMs: hb.positionMs, baseAt: performance.now(), playing: hb.playing })
      } else if (hb.playing !== st.playing) {
        useStore.getState().setNetMusic({ playing: hb.playing, basePositionMs: live, baseAt: performance.now() })
      }
    }) as never)

    return () => {
      disposed = true
      offStatus()
      offState()
      offBeat()
    }
  }, [])
}
