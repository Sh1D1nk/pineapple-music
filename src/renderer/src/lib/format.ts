export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatRemaining(current: number, duration: number): string {
  const left = Math.max(0, duration - current)
  return `-${formatTime(left)}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

export function formatDurationLabel(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)} 秒`
  const minutes = Math.round(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`
}

export function artistsLabel(artists: string[]): string {
  return artists.join('、')
}

export function formatBitrate(bps: number | null): string {
  if (!bps) return '—'
  return `${Math.round(bps / 1000)} kbps`
}

export function formatSampleRate(hz: number | null): string {
  if (!hz) return '—'
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
}
