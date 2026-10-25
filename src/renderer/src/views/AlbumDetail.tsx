import { useMemo, type JSX } from 'react'
import { useStore, useCurrentSongId, useIsPlaying } from '../state/store'
import { buildAlbums, songsOfAlbum } from '../lib/group'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { TrackTable } from '../components/TrackTable'
import { formatCount, formatDurationLabel } from '../lib/format'
import { MORPH_COVER } from '../lib/transition'
import { coverUrl } from '../bridge'
import styles from '../components/views.module.css'

interface Props {
  albumKey: string
}

export function AlbumDetail({ albumKey }: Props): JSX.Element {
  const songs = useStore((s) => s.songs)
  const songIds = useStore((s) => s.songIds)
  const setView = useStore((s) => s.setView)
  const playSongs = useStore((s) => s.playSongs)
  const setContextMenu = useStore((s) => s.setContextMenu)

  const albums = useMemo(
    () => buildAlbums(songIds.map((id) => songs[id]).filter((s): s is NonNullable<typeof s> => Boolean(s))),
    [songIds, songs]
  )
  const album = albums.get(albumKey)
  const tracks = useMemo(() => (album ? songsOfAlbum(songs, album) : []), [album, songs])
  const current = useCurrentSongId()
  const playing = useIsPlaying()
  const totalDuration = tracks.reduce((sum, t) => sum + t.durationSec, 0)

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
          style={{ backgroundImage: `url(${coverUrl(album.coverId, 240)})` }}
          aria-hidden="true"
        />
      )}
      <div className={styles.albumHero}>
        <div className={styles.albumCover} style={{ viewTransitionName: MORPH_COVER }}>
          {/* 详情页大图就是过渡形变的目标帧：必须 eager 立即解码，否则形变动画里它还是灰块 */}
          <Cover coverId={album.coverId} size={640} radius={10} alt={album.name} priority />
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
          <div className={styles.albumSub}>
            {[album.genre, album.year ? String(album.year) : null].filter(Boolean).join(' · ') || '未知流派'}
          </div>
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

      <div className={styles.albumFooter}>
        {formatCount(tracks.length)} 首歌曲，{formatDurationLabel(totalDuration)}
      </div>
    </div>
  )
}
