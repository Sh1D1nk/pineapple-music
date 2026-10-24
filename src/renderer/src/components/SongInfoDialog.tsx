import { useEffect, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { bridge } from '../bridge'
import type { SongInfoExtra } from '@shared/types'
import { Cover } from './Cover'
import {
  formatBitrate,
  formatBytes,
  formatSampleRate,
  formatTime
} from '../lib/format'
import styles from './overlays.module.css'

type Tab = 'detail' | 'lyrics' | 'file'

export function SongInfoDialog(): JSX.Element | null {
  const songId = useStore((s) => s.infoSongId)
  const setInfoSongId = useStore((s) => s.setInfoSongId)
  const songs = useStore((s) => s.songs)
  const lyrics = useStore((s) => s.lyrics)
  const [tab, setTab] = useState<Tab>('detail')
  const [extra, setExtra] = useState<SongInfoExtra | null>(null)

  useEffect(() => {
    if (!songId) return
    setTab('detail')
    void bridge.songInfo(songId).then(setExtra)
  }, [songId])

  useEffect(() => {
    if (!songId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setInfoSongId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [songId, setInfoSongId])

  if (!songId) return null
  const song = songs[songId]
  if (!song) return null

  const creditCandidates: [string, string][] = [
    ['作曲', song.credits.composer.join('、')],
    ['作词', song.credits.lyricist.join('、')],
    ['编曲', song.credits.arranger.join('、')],
    ['制作人', song.credits.producer.join('、')],
    ['混音', song.credits.mixer.join('、')],
    ['母带', song.credits.mastering.join('、')],
    ['演唱', (song.credits.performer.length > 0 ? song.credits.performer : song.artists).join('、')]
  ]
  const creditRows = creditCandidates.filter(([, value]) => value.length > 0)

  const detailRows: [string, string][] = [
    ['专辑', song.album],
    ['专辑艺人', song.albumArtist],
    [
      '曲目',
      song.trackNo
        ? `${song.trackNo}${song.trackTotal ? ` / ${song.trackTotal}` : ''}`
        : '—'
    ],
    [
      '碟片',
      song.discNo ? `${song.discNo}${song.discTotal ? ` / ${song.discTotal}` : ''}` : '—'
    ],
    ['年份', song.year ? String(song.year) : '—'],
    ['流派', song.genre ?? '—'],
    ['BPM', song.bpmTag ? String(song.bpmTag) : song.analysis ? song.analysis.bpm.toFixed(1) : '—']
  ]

  return (
    <div className={styles.scrim} onPointerDown={(event) => event.target === event.currentTarget && setInfoSongId(null)}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="歌曲信息">
        <div className={styles.modalHeader}>
          <div className={styles.modalCover}>
            <Cover coverId={song.coverId} size={240} radius={8} alt={song.title} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className={`${styles.modalTitle} ellipsis`}>{song.title}</div>
            <div className={`${styles.modalSub} ellipsis`}>{song.artists.join('、')}</div>
            <div className={`${styles.modalSub} ellipsis`}>{song.album}</div>
          </div>
        </div>

        <div className={styles.tabs}>
          {(['detail', 'lyrics', 'file'] as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              className={`${styles.tab} ${tab === entry ? styles.tabActive : ''}`}
              onClick={() => setTab(entry)}
            >
              {entry === 'detail' ? '详细信息' : entry === 'lyrics' ? '歌词' : '文件'}
            </button>
          ))}
        </div>

        <div className={styles.modalBody}>
          {tab === 'detail' && (
            <>
              <div className={styles.detailSection}>
                <div className={styles.detailSectionTitle}>创作者</div>
                {creditRows.length === 0 && <div className={styles.emptyNote}>标签中没有创作者信息</div>}
                {creditRows.map(([label, value]) => (
                  <div key={label} className={styles.detailRow}>
                    <div className={styles.detailLabel}>{label}</div>
                    <div className={styles.detailValue}>{value}</div>
                  </div>
                ))}
              </div>
              <div className={styles.detailSection}>
                <div className={styles.detailSectionTitle}>歌曲</div>
                {detailRows.map(([label, value]) => (
                  <div key={label} className={styles.detailRow}>
                    <div className={styles.detailLabel}>{label}</div>
                    <div className={styles.detailValue}>{value}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'lyrics' && (
            <>
              <div className={styles.detailRow}>
                <div className={styles.detailLabel}>来源</div>
                <div className={styles.detailValue}>{lyrics?.sourceLabel ?? '无'}</div>
              </div>
              {lyrics?.filePath && (
                <div className={styles.detailRow}>
                  <div className={styles.detailLabel}>文件</div>
                  <div className={styles.detailValue}>{lyrics.filePath}</div>
                </div>
              )}
              <div className={styles.lyricRaw} style={{ marginTop: 12 }}>
                {lyrics?.raw?.trim() || '暂无歌词'}
              </div>
            </>
          )}

          {tab === 'file' && extra && (
            <>
              {(
                [
                  ['格式', extra.format],
                  ['编码', extra.codec],
                  ['比特率', formatBitrate(extra.bitrate)],
                  ['采样率', formatSampleRate(extra.sampleRate)],
                  ['位深', extra.bitDepth ? `${extra.bitDepth} bit` : '—'],
                  ['声道', extra.channels ? String(extra.channels) : '—'],
                  ['大小', formatBytes(extra.fileSize)],
                  ['时长', formatTime(song.durationSec)],
                  ['路径', extra.path],
                  [
                    '响度',
                    extra.analysis
                      ? `${extra.analysis.lufs.toFixed(1)} LUFS · 有效 ${
                          extra.analysis.audioEnd - extra.analysis.audioStart > 0
                            ? formatTime(extra.analysis.audioEnd - extra.analysis.audioStart)
                            : '—'
                        }`
                      : '未分析'
                  ],
                  [
                    '节拍',
                    extra.analysis
                      ? `${extra.analysis.bpm.toFixed(1)} BPM · 稳定度 ${Math.round(
                          extra.analysis.grid.stability * 100
                        )}%`
                      : '未分析'
                  ],
                  ['分轨', extra.stem?.state === 'ready' ? '已完成' : '未安装分轨模型']
                ] as [string, string][]
              ).map(([label, value]) => (
                <div key={label} className={styles.detailRow}>
                  <div className={styles.detailLabel}>{label}</div>
                  <div className={styles.detailValue}>{value}</div>
                </div>
              ))}
            </>
          )}
          {tab === 'file' && !extra && <div className={styles.emptyNote}>正在读取文件信息…</div>}
        </div>
      </div>
    </div>
  )
}
