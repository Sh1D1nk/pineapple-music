import { useMemo, type JSX } from 'react'
import { useStore, useCurrentSongId, useIsPlaying } from '../state/store'
import { albumsOf, buildAlbums, songsOfAlbum } from '../lib/group'
import { PERF_LEGACY } from '../perf/flags'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { TrackTable } from '../components/TrackTable'
import { formatSummary } from '../lib/format'
import { MORPH_COVER } from '../lib/transition'
import { coverUrl } from '../bridge'
import styles from '../components/views.module.css'
import { phaseForKey } from '../perf/core'
import { viewOpenKey } from '../perf/keys'

interface Props {
  albumKey: string
}

export function AlbumDetail({ albumKey }: Props): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const setView = useStore((s) => s.setView)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)

  // 分组走跨挂载的 WeakMap 缓存：打开详情页不再把整个曲库重新聚合一遍
  const albums = useMemo(
    () =>
      PERF_LEGACY
        ? buildAlbums(songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s)))
        : albumsOf(songs, songIds),
    [songIds, songs]
  )
  const album = albums.get(albumKey)
  // data 阶段：详情页的数据来自内存缓存，真正的成本在渲染/封面；这里只把时刻标出来
  phaseForKey(viewOpenKey({ kind: 'album', key: albumKey }), 'data')
  const tracks = useMemo(() => (album ? songsOfAlbum(songs, album) : []), [album, songs])
  const current = useCurrentSongId()
  const playing = useIsPlaying()
  const summary = formatSummary(
    tracks.length,
    tracks.reduce((sum, t) => sum + t.durationSec, 0),
    tracks.reduce((sum, t) => sum + (t.fileSize || 0), 0)
  )

  if (!album) {
    return (
      <div className={styles.page}>
        <h1 className="pageTitle">专辑不存在</h1>
        <button type="button" className={styles.secondaryButton} onClick={() => setView({ kind: 'albums' })}>
          返回专辑
        </button>
      </div>
    )
  }

  return (
    <div className={`${styles.page} ${styles.albumPage}`}>
      {/* 专辑封面艺术图：按 cover 裁切、压暗、底部渐隐成页面底色。
          它只是背景，不拦截点击，也不参与 View Transition（形变只作用于 MORPH_COVER 那一个封面）。
          用 240px 那档 URL：与列表卡片同图 → 内存缓存命中、无需重新解码；
          反正会被 blur(28px) 化成色块，640px 属于纯浪费，还是过渡动画掉帧的大头。 */}
      {album.coverId && (
        <div
          className={styles.albumBg}
          // 80 档 + 蒙层：240 放大后封面上的大字会以巨大字号铺满页面（很丑），
          // 80 档只剩色晕；配合径向蒙版与低透明度，氛围足够且几乎零成本。
          style={{ backgroundImage: `url(${coverUrl(album.coverId, 80)})` }}
          aria-hidden="true"
        />
      )}
      <div className={styles.albumHero}>
        <div className={styles.albumCoverWrap}>
          {/* 封面微光：从 80px 缩图取的静态光晕，只在页面内、不参与形变和交互。
              灰度/黑白封面天然没有饱和度 → 自动退化为中性灰光，不会出现脏色。 */}
          {album.coverId && (
            <div
              className={styles.coverGlow}
              style={{ backgroundImage: `url(${coverUrl(album.coverId, 80)})` }}
              aria-hidden="true"
            />
          )}
          <div className={styles.albumCover} data-open-cover style={{ viewTransitionName: MORPH_COVER }}>
            {/* 详情页大图就是过渡形变的目标帧：必须 eager 立即解码，否则形变动画里它还是灰块 */}
            <Cover coverId={album.coverId} size={640} radius={14} alt={album.name} priority />
          </div>
        </div>
        <div className={styles.albumMeta}>
          <div className={styles.albumTitle}>{album.name}</div>
          <button
            type="button"
            className={styles.albumArtist}
            onClick={() => setView({ kind: 'artist', name: album.artist })}
          >
            {album.artist}
          </button>
          {[album.genre, album.year ? String(album.year) : null].filter(Boolean).length > 0 && (
            <div className={styles.albumSub}>
              {[album.genre, album.year ? String(album.year) : null].filter(Boolean).join(' · ')}
            </div>
          )}
          <div className={styles.albumButtons}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => playSongs(tracks.map((t) => t.id), 0)}
            >
              <Icon name="play" size={14} />
              播放
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                const shuffled = [...tracks].sort(() => Math.random() - 0.5)
                playSongs(shuffled.map((t) => t.id), 0)
              }}
            >
              <Icon name="shuffle" size={14} />
              随机播放
            </button>
          </div>
        </div>
      </div>

      <TrackTable
        songs={tracks}
        variant="album"
        currentId={current}
        playing={playing}
        showDiscHeaders={(album.discCount ?? 1) > 1}
        onPlay={(_song, index) => playSongs(tracks.map((t) => t.id), index)}
        onContextMenu={(event, song) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY, songId: song.id, albumKey })
        }}
      />

      <div className={styles.albumFooter}>{summary}</div>
    </div>
  )
}
