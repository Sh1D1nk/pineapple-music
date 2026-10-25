import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../state/store'
import { bridge } from '../bridge'
import { albumKeyOf } from '../lib/group'
import { copyText } from '../lib/clipboard'
import { Icon } from './Icon'
import styles from './overlays.module.css'

interface Item {
  id: string
  label: string
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  run: () => void | Promise<void>
}

/**
 * 歌词页右键菜单。
 *
 * 对应插件的 `openMenu()` / `openLineMenu()`：整页右键给一组，歌词行右键给「复制这一行」。
 * 菜单自己从 store 取当前歌曲与设置，因此可以挂在 overlayLayer 上，
 * 不受全屏页 transform 形成的包含块影响。
 */
export function LyricsMenu(): JSX.Element | null {
  const menu = useStore((s) => s.lyricsMenu)
  const setMenu = useStore((s) => s.setLyricsMenu)
  const songs = useStore((s) => s.songs)
  const playback = useStore((s) => s.playback)
  const settings = useStore((s) => s.settings)
  const favorites = useStore((s) => s.favorites)
  const toggleFavoriteSong = useStore((s) => s.toggleFavoriteSong)
  const updateSettings = useStore((s) => s.updateSettings)
  const setInfoSongId = useStore((s) => s.setInfoSongId)
  const setView = useStore((s) => s.setView)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const setLyricsSettingsOpen = useStore((s) => s.setLyricsSettingsOpen)
  const pushToast = useStore((s) => s.pushToast)

  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const song = songs[playback.queue[playback.index]?.songId ?? '']

  const groups = useMemo<Item[][]>(() => {
    if (!menu) return []
    if (menu.kind === 'line') {
      const text = (menu.text ?? '').trim()
      const sub = (menu.sub ?? '').trim()
      if (!text && !sub) return []
      return [
        [
          {
            id: 'copyLine',
            label: `复制该行歌词${text ? `：${text.slice(0, 24)}` : ''}`,
            run: async () => {
              const ok = await copyText(text)
              pushToast(ok ? '已复制该行歌词' : '复制失败，剪贴板不可用')
            }
          }
        ],
        [
          {
            id: 'copyLineAll',
            label: '复制该行（含翻译 / 音译）',
            run: async () => {
              const ok = await copyText([text, sub].filter(Boolean).join('\n'))
              pushToast(ok ? '已复制整行歌词' : '复制失败，剪贴板不可用')
            }
          }
        ]
      ]
    }
    if (!song) {
      return [
        [
          { id: 'noSong', label: '未在播放', disabled: true, run: () => undefined },
          { id: 'settings', label: '歌词页设置…', run: () => setLyricsSettingsOpen(true) }
        ]
      ]
    }
    const artist = song.artists[0] ?? song.albumArtist
    const favorited = favorites.songs.includes(song.id)
    return [
      [
        {
          id: 'favorite',
          label: favorited ? '取消收藏歌曲' : '收藏歌曲',
          checked: favorited,
          run: async () => {
            await toggleFavoriteSong(song.id)
            pushToast(favorited ? '已取消收藏' : `已收藏「${song.title}」`)
          }
        }
      ],
      [
        {
          id: 'artist',
          label: `查看歌手：${artist}`,
          run: () => {
            setFullscreen(false)
            setView({ kind: 'artist', name: artist })
          }
        },
        {
          id: 'album',
          label: `查看专辑：${song.album}`,
          run: () => {
            setFullscreen(false)
            setView({ kind: 'album', key: albumKeyOf(song) })
          }
        }
      ],
      [
        {
          id: 'copy',
          label: '复制歌曲信息',
          run: async () => {
            const payload = {
              title: song.title,
              artists: song.artists,
              albumArtist: song.albumArtist,
              album: song.album,
              year: song.year,
              trackNo: song.trackNo,
              durationSec: song.durationSec,
              codec: song.codec,
              bitrate: song.bitrate,
              sampleRate: song.sampleRate,
              bitDepth: song.bitDepth,
              fileSize: song.fileSize,
              path: song.path
            }
            const ok = await copyText(JSON.stringify(payload, null, 2))
            pushToast(ok ? '已复制歌曲信息' : '复制失败，剪贴板不可用')
          }
        },
        {
          id: 'info',
          label: '歌曲信息…',
          run: () => setInfoSongId(song.id)
        }
      ],
      [
        {
          id: 'translation',
          label: '显示翻译歌词',
          checked: settings.showTranslation,
          run: () => {
            void updateSettings({ showTranslation: !settings.showTranslation })
            pushToast(settings.showTranslation ? '已隐藏翻译歌词' : '已显示翻译歌词')
          }
        },
        {
          id: 'roman',
          label: '显示音译歌词',
          checked: settings.showRoman,
          run: () => {
            void updateSettings({ showRoman: !settings.showRoman })
            pushToast(settings.showRoman ? '已隐藏音译歌词' : '已显示音译歌词')
          }
        },
        {
          id: 'fullscreen',
          label: '切换系统全屏',
          run: async () => {
            const active = await bridge.isFullScreen()
            await bridge.setFullScreen(!active)
            pushToast(active ? '已退出系统全屏' : '已进入系统全屏')
          }
        }
      ],
      [
        { id: 'settings', label: '歌词页设置…', run: () => setLyricsSettingsOpen(true) },
        { id: 'close', label: '退出歌词页面', danger: true, run: () => setFullscreen(false) }
      ]
    ]
  }, [
    menu,
    song,
    favorites.songs,
    settings.showTranslation,
    settings.showRoman,
    setFullscreen,
    setInfoSongId,
    setLyricsSettingsOpen,
    setView,
    pushToast,
    toggleFavoriteSong,
    updateSettings
  ])

  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    })
  }, [menu, groups.length])

  useEffect(() => {
    if (!menu) return undefined
    const onDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setMenu(null)
    }
    const onWheel = (): void => setMenu(null)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', onWheel, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [menu, setMenu])

  useEffect(() => {
    setPos(null)
  }, [menu?.x, menu?.y, menu?.kind])

  if (!menu || groups.length === 0) return null

  return (
    <div
      ref={ref}
      className={styles.lyricsMenu}
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {groups.map((group, index) => (
        <div key={index} className={styles.lyricsMenuGroup}>
          {group.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              disabled={item.disabled}
              className={`${styles.lyricsMenuRow} ${item.danger ? styles.lyricsMenuDanger : ''}`}
              onClick={() => {
                setMenu(null)
                void item.run()
              }}
            >
              <span className={styles.lyricsMenuTick}>
                {item.checked ? <Icon name="check" size={11} /> : null}
              </span>
              <span className={styles.lyricsMenuLabel}>{item.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
