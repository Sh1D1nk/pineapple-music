import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { bridge } from '../bridge'
import { songsOfAlbum, buildAlbums } from '../lib/group'
import styles from './overlays.module.css'

export function ContextMenu(): JSX.Element | null {
  const menu = useStore((s) => s.contextMenu)
  const setContextMenu = useStore((s) => s.setContextMenu)
  const songs = useStore((s) => s.songs)
  const playSongNow = useStore((s) => s.playSongNow)
  const addNext = useStore((s) => s.addNext)
  const addLater = useStore((s) => s.addLater)
  const playSongs = useStore((s) => s.playSongs)
  const setInfoSongId = useStore((s) => s.setInfoSongId)
  const pushToast = useStore((s) => s.pushToast)
  const favorites = useStore((s) => s.favorites)
  const toggleFavoriteSong = useStore((s) => s.toggleFavoriteSong)
  const toggleFavoriteAlbum = useStore((s) => s.toggleFavoriteAlbum)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const left = Math.min(menu.x, window.innerWidth - rect.width - 8)
    const top = Math.min(menu.y, window.innerHeight - rect.height - 8)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setContextMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, setContextMenu])

  if (!menu) return null
  const song = songs[menu.songId]
  if (!song) return null

  const albums = buildAlbums(Object.values(songs))
  const album = menu.albumKey ? albums.get(menu.albumKey) : undefined

  return (
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
      role="menu"
    >
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          playSongNow(song.id)
          setContextMenu(null)
        }}
      >
        播放
      </button>
      <div className={styles.menuSeparator} />
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          void toggleFavoriteSong(song.id)
          setContextMenu(null)
        }}
      >
        <span>{favorites.songs.includes(song.id) ? '取消收藏' : '收藏'}</span>
        <span className={styles.menuShortcut}>
          {favorites.songs.includes(song.id) ? '★' : '☆'}
        </span>
      </button>
      {album && (
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => {
            void toggleFavoriteAlbum(album.key)
            setContextMenu(null)
          }}
        >
          <span>{favorites.albums.includes(album.key) ? '取消收藏专辑' : '收藏整张专辑'}</span>
          <span className={styles.menuShortcut}>
            {favorites.albums.includes(album.key) ? '★' : '☆'}
          </span>
        </button>
      )}
      <div className={styles.menuSeparator} />
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          addNext([song.id])
          setContextMenu(null)
        }}
      >
        接下来播放
      </button>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          addLater([song.id])
          setContextMenu(null)
        }}
      >
        稍后播放
      </button>
      {album && (
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => {
            const tracks = songsOfAlbum(songs, album).sort(() => Math.random() - 0.5)
            playSongs(tracks.map((t) => t.id), 0)
            setContextMenu(null)
          }}
        >
          随机播放（专辑）
        </button>
      )}
      <div className={styles.menuSeparator} />
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          void bridge.showInFolder(song.path)
          setContextMenu(null)
        }}
      >
        在资源管理器中显示
      </button>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          setInfoSongId(song.id)
          setContextMenu(null)
        }}
      >
        歌曲信息…
      </button>
      <button
        type="button"
        className={styles.menuItem}
        onClick={() => {
          void navigator.clipboard.writeText(`${song.title} — ${song.artists.join('、')}`)
          pushToast('已复制歌名')
          setContextMenu(null)
        }}
      >
        复制歌名
      </button>
    </div>
  )
}
