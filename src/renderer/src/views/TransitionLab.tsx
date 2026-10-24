import { useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { buildPlan, phrasesFor } from '../audio/automix'
import { renderBridge } from '../audio/bridgeRenderer'
import { engine } from '../audio/engine'
import type { TransitionPlan } from '@shared/transition/planner'
import type { SongMeta } from '@shared/types'
import { formatTime } from '../lib/format'
import styles from '../components/settings.module.css'
import viewStyles from '../components/views.module.css'

function drawPlan(canvas: HTMLCanvasElement, plan: TransitionPlan): void {
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  canvas.width = width * dpr
  canvas.height = height * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)

  const duration = plan.bridgeDuration || 1
  const x = (t: number): number => 10 + (t / duration) * (width - 20)
  const y = (v: number): number => height - 24 - v * (height - 44)

  ctx.strokeStyle = 'rgba(128,128,128,.25)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const yy = 20 + (i * (height - 44)) / 4
    ctx.beginPath()
    ctx.moveTo(10, yy)
    ctx.lineTo(width - 10, yy)
    ctx.stroke()
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#fff'

  // bass swap marker
  ctx.strokeStyle = 'rgba(250,36,60,.55)'
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(x(plan.bassSwapAt), 12)
  ctx.lineTo(x(plan.bassSwapAt), height - 20)
  ctx.stroke()
  ctx.setLineDash([])

  const plot = (points: { at: number; value: number }[], color: string, scale = 1): void => {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    points.forEach((point, i) => {
      const px = x(point.at)
      const py = y(Math.min(1, point.value * scale))
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()
  }

  plot(plan.currentGain, 'rgba(250,36,60,.9)')
  plot(plan.nextGain, 'rgba(80,180,255,.9)')
  plot(plan.rate.map((k) => ({ at: k.at, value: (k.value - 1) * 8 + 0.5 })), 'rgba(255,200,60,.9)')

  if (plan.vocalOut) {
    ctx.fillStyle = 'rgba(250,36,60,.12)'
    ctx.fillRect(x(plan.vocalOut.start), 12, Math.max(2, x(plan.vocalOut.end) - x(plan.vocalOut.start)), height - 32)
  }

  ctx.fillStyle = accent
  ctx.font = '10px system-ui'
  ctx.fillText(`0:00`, 10, height - 6)
  ctx.fillText(`${duration.toFixed(0)}s`, width - 32, height - 6)
  ctx.fillStyle = 'rgba(250,36,60,.9)'
  ctx.fillText('当前增益', 14, 16)
  ctx.fillStyle = 'rgba(80,180,255,.9)'
  ctx.fillText('下一首增益', 70, 16)
  ctx.fillStyle = 'rgba(255,200,60,.9)'
  ctx.fillText('变速', 140, 16)
}

function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels
  const length = buffer.length
  const bytes = 44 + length * channels * 2
  const view = new DataView(new ArrayBuffer(bytes))
  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, bytes - 8, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, length * channels * 2, true)
  let offset = 44
  const planes = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i))
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, planes[c]![i]!))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' })
}

export function TransitionLab(): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const settings = useStore((s) => s.settings)
  const [aId, setAId] = useState<string>('')
  const [bId, setBId] = useState<string>('')
  const [duration, setDuration] = useState(settings.automix.durationSec)
  const [maxRate, setMaxRate] = useState(settings.automix.maxRatePct)
  const [protect, setProtect] = useState(settings.automix.protectLastPhrase)
  const [plan, setPlan] = useState<TransitionPlan | null>(null)
  const [status, setStatus] = useState<string>('选择两首已分析的歌曲开始')
  const [renderMs, setRenderMs] = useState<number | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const analyzed = useMemo(
    () => songIds.map((id) => songs[id]).filter((s): s is SongMeta => Boolean(s?.analysis)),
    [songIds, songs]
  )

  const render = async (): Promise<void> => {
    const a = songs[aId]
    const b = songs[bId]
    if (!a || !b) {
      setStatus('请选择两首歌')
      return
    }
    setStatus('规划中…')
    const [pa, pb] = await Promise.all([phrasesFor(a), phrasesFor(b)])
    const nextPlan = buildPlan(a, b, {
      durationSec: duration,
      maxRatePct: maxRate,
      protectLastPhrase: protect,
      baseFadeSec: settings.automix.baseFadeSec,
      stemsReady: false,
      currentPhrases: pa,
      nextPhrases: pb
    })
    if (!nextPlan) {
      setStatus('这两首歌缺少节拍分析，无法规划')
      return
    }
    setPlan(nextPlan)
    setStatus(`渲染中（${nextPlan.level} 级，${nextPlan.bridgeDuration.toFixed(1)} 秒）…`)
    const started = performance.now()
    try {
      const rendered = await renderBridge(nextPlan, a, b)
      if (!rendered) throw new Error('empty render')
      bufferRef.current = rendered.buffer
      setRenderMs(Math.round(performance.now() - started))
      setStatus(
        `${nextPlan.level} 级过渡就绪 · ${rendered.stretched ? '已应用时变变速' : '未变速'} · 拍点误差 ${nextPlan.alignmentErrorMs.toFixed(1)} ms`
      )
      if (canvasRef.current) drawPlan(canvasRef.current, nextPlan)
    } catch (err) {
      setStatus(`渲染失败：${String(err)}`)
    }
  }

  const audition = async (): Promise<void> => {
    const buffer = bufferRef.current
    if (!buffer) return
    const ctx = engine.getContext()
    if (ctx.state === 'suspended') await ctx.resume()
    sourceRef.current?.stop()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
    sourceRef.current = source
    setStatus('正在试听渲染结果')
  }

  const exportWav = (): void => {
    const buffer = bufferRef.current
    if (!buffer) return
    const blob = encodeWav(buffer)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `transition-${Date.now()}.wav`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  return (
    <div className={viewStyles.page}>
      <h1 className="pageTitle" style={{ marginBottom: 6 }}>
        Transition Lab
      </h1>
      <p className="pageSubtitle" style={{ marginBottom: 22 }}>
        离线渲染任意两首歌的过渡，试听并导出 WAV。Ctrl+Shift+L 可随时打开
      </p>

      <div className={styles.labGrid}>
        <label>
          <div className={styles.statLabel} style={{ marginBottom: 4 }}>
            当前曲目
          </div>
          <select className={styles.labSelect} value={aId} onChange={(event) => setAId(event.target.value)}>
            <option value="">选择…</option>
            {analyzed.map((song) => (
              <option key={song.id} value={song.id}>
                {song.title} — {song.analysis?.bpm.toFixed(1)} BPM
              </option>
            ))}
          </select>
        </label>
        <label>
          <div className={styles.statLabel} style={{ marginBottom: 4 }}>
            下一首
          </div>
          <select className={styles.labSelect} value={bId} onChange={(event) => setBId(event.target.value)}>
            <option value="">选择…</option>
            {analyzed.map((song) => (
              <option key={song.id} value={song.id}>
                {song.title} — {song.analysis?.bpm.toFixed(1)} BPM
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.section} style={{ marginTop: 16 }}>
        <div className={styles.row}>
          <div className={styles.rowLabel}>过渡时长</div>
          <div className={styles.sliderRow}>
            <input type="range" min={8} max={45} value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            <span className={styles.value}>{duration} 秒</span>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.rowLabel}>最大变速</div>
          <div className={styles.sliderRow}>
            <input type="range" min={1} max={12} value={maxRate} onChange={(e) => setMaxRate(Number(e.target.value))} />
            <span className={styles.value}>{maxRate}%</span>
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.rowLabel}>保护末句人声</div>
          <button
            type="button"
            className={`${styles.switch} ${protect ? styles.switchOn : ''}`}
            onClick={() => setProtect(!protect)}
          >
            <span className={styles.knob} />
          </button>
        </div>
        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.segment}
            style={{ height: 30 }}
            onClick={() => void render()}
          >
            离线渲染
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void audition()}>
            试听
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={exportWav}>
            导出 WAV
          </button>
        </div>
      </div>

      <canvas ref={canvasRef} className={styles.labCanvas} style={{ marginTop: 16 }} />

      <div className={styles.labStats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>级别</div>
          <div className={styles.statValue}>{plan?.level ?? '—'}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>拍点相位误差</div>
          <div className={styles.statValue}>{plan ? `${plan.alignmentErrorMs.toFixed(1)} ms` : '—'}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>渲染耗时</div>
          <div className={styles.statValue}>{renderMs !== null ? `${renderMs} ms` : '—'}</div>
        </div>
      </div>

      {plan && (
        <div className={styles.note}>
          <div>
            过渡起点 {formatTime(plan.startTime)} · 结束 {formatTime(plan.endTime)} · 下一首进入偏移{' '}
            {plan.nextStartOffset.toFixed(2)}s · 人声退出{' '}
            {plan.vocalOut ? `${plan.vocalOut.start.toFixed(1)}–${plan.vocalOut.end.toFixed(1)}s` : '未启用'}
          </div>
          <div>变速曲线：{plan.rate.length} 个关键帧 · 低频交换 {plan.bassSwapAt.toFixed(1)}s</div>
          {plan.notes.length > 0 && <div>说明：{plan.notes.join('；')}</div>}
        </div>
      )}

      <div className={styles.status}>{status}</div>
    </div>
  )
}
