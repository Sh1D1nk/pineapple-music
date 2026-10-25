import { useEffect, useMemo, useState, type JSX } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useStore } from '../state/store'
import { bridge } from '../bridge'
import styles from './overlays.module.css'

type PageId = 'lyric' | 'song' | 'bg' | 'source' | 'player' | 'mix' | 'misc' | 'debug' | 'about'

const PAGES: { id: PageId; name: string }[] = [
  { id: 'lyric', name: '歌词' },
  { id: 'song', name: '歌曲信息' },
  { id: 'bg', name: '背景' },
  { id: 'source', name: '歌词源' },
  { id: 'player', name: '歌词播放器' },
  { id: 'mix', name: '播放' },
  { id: 'misc', name: '杂项' },
  { id: 'debug', name: '调试' }
]

type Control =
  | { kind: 'switch'; value: boolean; onChange: (value: boolean) => void }
  | {
      kind: 'range'
      value: number
      min: number
      max: number
      step: number
      format: (value: number) => string
      onChange: (value: number) => void
    }
  | {
      kind: 'select'
      value: string
      options: { value: string; label: string }[]
      onChange: (value: string) => void
    }

interface Row {
  label: string
  hint?: string
  control: Control
}

interface PaneSpec {
  rows: Row[]
  note?: string
  kv?: [string, string][]
}

const mmss = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 歌词页内设置窗（插件 `openSettings()` 的对应实现）。
 *
 * 与插件的差别只有数据归宿：插件写自己的 localStorage，这里写 AppSettings，
 * 所以歌词页里的改动与设置页、右键菜单里的开关永远是同一份值。
 */
export function LyricsSettingsDialog(): JSX.Element | null {
  const open = useStore((s) => s.lyricsSettingsOpen)
  const setOpen = useStore((s) => s.setLyricsSettingsOpen)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const songs = useStore((s) => s.songs)
  const playback = useStore((s) => s.playback)
  const lyrics = useStore((s) => s.lyrics)
  const qualityLevel = useStore((s) => s.lyricsQualityLevel)
  const pushToast = useStore((s) => s.pushToast)
  const setView = useStore((s) => s.setView)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const [page, setPage] = useState<PageId>('lyric')
  const [version, setVersion] = useState('')

  useEffect(() => {
    if (!open) {
      setPage('lyric')
      return
    }
    void bridge.version().then(setVersion).catch(() => setVersion(''))
  }, [open])

  const song = songs[playback.queue[playback.index]?.songId ?? '']
  const automix = settings.automix

  const patchAutomix = (patch: Partial<typeof automix>): void => {
    void update({ automix: { ...automix, ...patch } })
  }

  const spec = useMemo<PaneSpec>(() => {
    const bool = (label: string, hint: string, value: boolean, onChange: (v: boolean) => void): Row => ({
      label,
      hint,
      control: { kind: 'switch', value, onChange }
    })
    const num = (
      label: string,
      hint: string,
      value: number,
      range: { min: number; max: number; step: number; format: (v: number) => string },
      onChange: (v: number) => void
    ): Row => ({ label, hint, control: { kind: 'range', value, ...range, onChange } })
    const sel = (
      label: string,
      hint: string,
      value: string,
      options: { value: string; label: string }[],
      onChange: (v: string) => void
    ): Row => ({ label, hint, control: { kind: 'select', value, options, onChange } })

    switch (page) {
      case 'lyric':
        return {
          rows: [
            sel('歌词字体', '优先使用本机苹方字体', settings.lyricFont, [
              { value: 'pingfang', label: '苹方' },
              { value: 'system', label: '跟随系统' }
            ], (v) => void update({ lyricFont: v as 'pingfang' | 'system' })),
            num('字号大小', '逐字歌词的基准字号倍数', settings.lyricFontScale, {
              min: 0.6,
              max: 2,
              step: 0.05,
              format: (v) => `${v.toFixed(2)}x`
            }, (v) => void update({ lyricFontScale: v })),
            sel('字号粗细', '歌词文字的笔画粗细', String(settings.lyricWeight), [
              { value: '300', label: '细' },
              { value: '400', label: '常规' },
              { value: '500', label: '中黑' },
              { value: '600', label: '半粗' },
              { value: '700', label: '粗' }
            ], (v) => void update({ lyricWeight: Number(v) })),
            bool('点击歌词跳转', '点击歌词行跳到对应播放位置', settings.lyricClickSeek, (v) =>
              void update({ lyricClickSeek: v })
            ),
            bool('显示翻译歌词', '优先使用歌词文件自带的翻译', settings.showTranslation, (v) =>
              void update({ showTranslation: v })
            ),
            bool('显示音译歌词', '歌曲无音译数据时不显示', settings.showRoman, (v) => void update({ showRoman: v }))
          ]
        }
      case 'song':
        return {
          rows: [
            bool('显示专辑名', '在歌手下方显示所属专辑', settings.showAlbum, (v) => void update({ showAlbum: v })),
            bool('封面悬停隐藏鼠标', '鼠标移到专辑封面上时隐藏指针', settings.coverHideCursor, (v) =>
              void update({ coverHideCursor: v })
            )
          ]
        }
      case 'bg':
        return {
          rows: [
            bool('显示歌词背景', '使用当前专辑封面作为背景', settings.bgEnabled, (v) => void update({ bgEnabled: v })),
            sel('背景类型', '流体取色 / 模糊封面 / 深色渐变', settings.bgType, [
              { value: 'flow', label: '流体背景' },
              { value: 'blur', label: '模糊封面' },
              { value: 'solid', label: '深色渐变' }
            ], (v) => void update({ bgType: v as 'flow' | 'blur' | 'solid' })),
            num('流体速度', '颜色流动的快慢', settings.bgFlowSpeed, {
              min: 0.1,
              max: 4,
              step: 0.05,
              format: (v) => v.toFixed(2)
            }, (v) => void update({ bgFlowSpeed: v })),
            num('渲染精度', '流体背景的渲染比例，越低越省性能', settings.bgRenderScale, {
              min: 0.2,
              max: 1,
              step: 0.05,
              format: (v) => `${Math.round(v * 100)}%`
            }, (v) => void update({ bgRenderScale: v })),
            num('渲染帧率', '0 为静止', settings.bgFps, {
              min: 0,
              max: 60,
              step: 1,
              format: (v) => (v > 0 ? `${Math.round(v)} FPS` : '静止')
            }, (v) => void update({ bgFps: v })),
            bool('性能模式', '降低背景分辨率与帧率，并关闭歌词模糊、缩放与弹簧动画', settings.bgPerf, (v) =>
              void update({ bgPerf: v })
            ),
            bool('自适应降质', '帧率持续不足时自动降档，恢复后缓慢升回', settings.adaptiveQuality, (v) =>
              void update({ adaptiveQuality: v })
            ),
            num('背景模糊', '模糊封面模式下的柔和程度', settings.bgBlur, {
              min: 0,
              max: 200,
              step: 2,
              format: (v) => `${Math.round(v)}px`
            }, (v) => void update({ bgBlur: v })),
            num('背景亮度', '默认 0.55', settings.bgBrightness, {
              min: 0.15,
              max: 1.2,
              step: 0.01,
              format: (v) => v.toFixed(2)
            }, (v) => void update({ bgBrightness: v })),
            num('背景饱和度', '默认 1.90', settings.bgSaturate, {
              min: 0.5,
              max: 3,
              step: 0.05,
              format: (v) => v.toFixed(2)
            }, (v) => void update({ bgSaturate: v }))
          ]
        }
      case 'source':
        return {
          rows: [
            sel('歌词来源优先级', '外挂文件优先，或内嵌标签优先', settings.lyricsPriority[0] ?? 'sidecar', [
              { value: 'sidecar', label: '外挂优先' },
              { value: 'embedded', label: '内嵌优先' }
            ], (v) =>
              void update({
                lyricsPriority: v === 'sidecar' ? ['sidecar', 'embedded', 'text'] : ['embedded', 'sidecar', 'text']
              })
            ),
            bool('自动回退', '当前来源取不到歌词时自动换下一个来源', settings.lyricAutoFallback, (v) =>
              void update({ lyricAutoFallback: v })
            )
          ],
          note:
            '外挂来源支持 .lrc / .ttml / .lys / .yrc / .qrc；内嵌来源读取 SYLT / USLT / ©lyr / LYRICS；纯文本按静态列表显示。'
        }
      case 'player':
        return {
          rows: [
            bool('歌词界面过渡动画', '进入 / 退出时的下拉与淡入缓动', settings.lyricTransition, (v) =>
              void update({ lyricTransition: v })
            ),
            bool('切歌按钮动画', '上一首 / 下一首按钮的按压动画', settings.btnAnim, (v) => void update({ btnAnim: v })),
            bool('封面与背景过渡', '切歌时封面与背景交叉淡入', settings.mediaAnim, (v) => void update({ mediaAnim: v })),
            num('文字高光亮度', '当前行已唱部分的高光强度', settings.lyricHighlight, {
              min: 0.3,
              max: 1.4,
              step: 0.02,
              format: (v) => v.toFixed(2)
            }, (v) => void update({ lyricHighlight: v })),
            bool('显示帧率', '在歌词页右上角显示实时帧率', settings.showFps, (v) => void update({ showFps: v })),
            bool('歌词模糊效果', '非当前行模糊处理（AMLL）', settings.lyricBlur, (v) => void update({ lyricBlur: v })),
            bool('歌词缩放效果', '非当前行轻微缩小（AMLL）', settings.lyricScale, (v) => void update({ lyricScale: v })),
            num('逐字渐变宽度', '0.01 近似逐字硬切，1.50 为整行渐变', settings.wordFade, {
              min: 0.01,
              max: 1.5,
              step: 0.01,
              format: (v) => v.toFixed(2)
            }, (v) => void update({ wordFade: v })),
            bool('隐藏已播放歌词', '已播放的歌词行淡出隐藏', settings.hidePassed, (v) => void update({ hidePassed: v }))
          ]
        }
      case 'mix':
        return {
          rows: [
            bool('自动衔接（AutoMix）', '按节拍与分轨规划过渡，关闭后只用短交叉淡化', automix.enabled, (v) =>
              patchAutomix({ enabled: v })
            ),
            num('过渡时长', '规划窗口的长度（插件为 0–12 秒的等功率淡入淡出）', automix.durationSec, {
              min: 8,
              max: 45,
              step: 1,
              format: (v) => `${Math.round(v)} 秒`
            }, (v) => patchAutomix({ durationSec: v })),
            num('最大变速幅度', '硬上限 ±12%', automix.maxRatePct, {
              min: 1,
              max: 12,
              step: 1,
              format: (v) => `${Math.round(v)}%`
            }, (v) => patchAutomix({ maxRatePct: v })),
            bool('分轨模式', '需要分轨模型；未安装时自动降级为整曲节拍对齐', automix.stems, (v) =>
              patchAutomix({ stems: v })
            ),
            num('基础淡入淡出', '降级到 D 级时使用', automix.baseFadeSec, {
              min: 2,
              max: 12,
              step: 1,
              format: (v) => `${Math.round(v)} 秒`
            }, (v) => patchAutomix({ baseFadeSec: v }))
          ],
          note:
            '插件用的是「宿主音量包络」式淡入淡出；本应用有双 deck 与分轨，因此这里是 A–E 五级过渡规划。完整的 AutoMix 参数（分轨预处理、线程、缓存）在设置页「播放 · AutoMix」。'
        }
      case 'misc':
        return {
          rows: [
            sel('顶栏样式', '插件作用于宿主底边栏，这里对应本应用的顶部播放胶囊', settings.barStyle, [
              { value: 'off', label: '关闭' },
              { value: 'blur', label: '模糊' }
            ], (v) => void update({ barStyle: v as 'off' | 'blur' })),
            num('不透明度', '数值越低越通透', settings.barOpacity, {
              min: 0.05,
              max: 0.9,
              step: 0.01,
              format: (v) => `${Math.round(v * 100)}%`
            }, (v) => void update({ barOpacity: v })),
            num('模糊强度', 'backdrop-filter 模糊半径', settings.barBlur, {
              min: 0,
              max: 60,
              step: 1,
              format: (v) => `${Math.round(v)}px`
            }, (v) => void update({ barBlur: v })),
            num('封面环境色', '顶栏玻璃里透出封面模糊后的色雾', settings.barCover, {
              min: 0,
              max: 0.9,
              step: 0.01,
              format: (v) => `${Math.round(v * 100)}%`
            }, (v) => void update({ barCover: v }))
          ]
        }
      case 'debug':
        return {
          rows: [],
          kv: [
            ['歌曲', song?.title ?? '未播放'],
            ['歌手', song?.artists.join(' / ') ?? '-'],
            ['专辑', song?.album ?? '-'],
            ['播放状态', playback.playing ? '播放中' : '已暂停'],
            ['进度', `${mmss(playback.position)} / ${mmss(playback.duration)}`],
            ['音量', `${Math.round(playback.volume * 100)}%${playback.muted ? '（静音）' : ''}`],
            [
              '歌词',
              lyrics
                ? `${lyrics.sourceLabel || lyrics.source} · ${
                    lyrics.kind === 'synced' ? `${lyrics.lines.length} 行` : lyrics.kind === 'plain' ? '纯文本' : '无'
                  }`
                : '未加载'
            ],
            ['翻译 / 音译', `${lyrics?.hasTranslation ? '有' : '无'} / ${lyrics?.hasRoman ? '有' : '无'}`],
            ['自适应档位', settings.adaptiveQuality ? `${qualityLevel} / 3` : '已关闭'],
            ['应用版本', version || '…']
          ]
        }
      case 'about':
      default:
        return { rows: [] }
    }
  }, [
    page,
    settings,
    automix,
    song,
    playback,
    lyrics,
    qualityLevel,
    version,
    update
  ])

  if (!open) return null

  const reset = async (): Promise<void> => {
    await update(DEFAULT_SETTINGS)
    pushToast('已恢复默认设置')
  }

  return (
    <div
      className={styles.lsScrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div className={styles.lsWindow} role="dialog" aria-label="歌词页设置">
        <div className={styles.lsTitlebar}>
          <div className={styles.lsLights}>
            <button
              type="button"
              className={`${styles.lsLight} ${styles.lsLightClose}`}
              title="关闭"
              onClick={() => setOpen(false)}
            />
            <span className={`${styles.lsLight} ${styles.lsLightDim}`} aria-hidden="true" />
            <span className={`${styles.lsLight} ${styles.lsLightGhost}`} aria-hidden="true" />
          </div>
          <div className={styles.lsTitle}>
            Apple Music-like Lyrics 插件设置{page === 'about' ? ' · 关于' : ''}
          </div>
        </div>
        <div className={styles.lsBody}>
          <div className={styles.lsSide}>
            {PAGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`${styles.lsSideItem} ${page === entry.id ? styles.lsSideOn : ''}`}
                onClick={() => setPage(entry.id)}
              >
                {entry.name}
              </button>
            ))}
            <button
              type="button"
              className={styles.lsSideFoot}
              onClick={() => setPage('about')}
            >
              关于 Apple Music-like Lyrics
            </button>
          </div>
          <div className={styles.lsVdiv} />
          <div className={styles.lsPane}>
            {page === 'about' ? (
              <div className={styles.lsAbout}>
                <h3>Apple Music-like Lyrics</h3>
                <p>
                  歌词渲染基于开源项目 AMLL（@applemusic-like-lyrics），提供逐字高亮、模糊与缩放等 Apple Music
                  风格的动画；本面板对齐「汽水音乐 AMLL 插件 v2.0」的交互与布局。
                </p>
                <p>
                  快捷键：<b>Ctrl + Alt + L</b> 开关歌词页，<b>Ctrl + L</b> 开关侧边歌词面板，<b>Esc</b> 依次收起菜单 /
                  设置窗 / 歌词页；歌词页内右键打开菜单，歌词行右键可复制该行。
                </p>
                <p>应用版本 {version || '…'} · 设置与设置页共用同一份（%APPDATA%\Pineapple Music\settings.json）。</p>
              </div>
            ) : (
              <>
                {spec.kv ? (
                  <div className={styles.lsBox}>
                    <div className={styles.lsKv}>
                      {spec.kv.map(([key, value]) => (
                        <FragmentRow key={key} label={key} value={value} />
                      ))}
                    </div>
                  </div>
                ) : null}
                {spec.rows.length > 0 ? (
                  <div className={styles.lsBox}>
                    {spec.rows.map((row, index) => (
                      <div key={`${row.label}-${index}`} className={styles.lsRow}>
                        <div className={styles.lsRowLabel}>
                          <b>{row.label}</b>
                          {row.hint ? <span>{row.hint}</span> : null}
                        </div>
                        <div className={styles.lsCtl}>
                          <ControlView control={row.control} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {spec.note ? <div className={styles.lsNote}>{spec.note}</div> : null}
                {page === 'mix' ? (
                  <div className={styles.lsReset} style={{ justifyContent: 'flex-start', paddingTop: 8 }}>
                    <button
                      type="button"
                      className={styles.lsResetButton}
                      onClick={() => {
                        setFullscreen(false)
                        setView({ kind: 'settings' })
                      }}
                    >
                      打开完整设置 ›
                    </button>
                  </div>
                ) : null}
                <div className={styles.lsReset}>
                  <button type="button" className={styles.lsResetButton} onClick={() => void reset()}>
                    恢复默认设置
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <b>{label}</b>
      <span>{value}</span>
    </>
  )
}

function ControlView({ control }: { control: Control }): JSX.Element {
  if (control.kind === 'switch') {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={control.value}
        className={`${styles.lsSwitch} ${control.value ? styles.lsSwitchOn : ''}`}
        onClick={() => control.onChange(!control.value)}
      >
        <span className={styles.lsKnob} />
      </button>
    )
  }
  if (control.kind === 'select') {
    return (
      <div className={styles.lsSeg}>
        {control.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`${styles.lsSegBtn} ${control.value === option.value ? styles.lsSegOn : ''}`}
            onClick={() => control.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <>
      <input
        type="range"
        className={styles.lsSlider}
        min={control.min}
        max={control.max}
        step={control.step}
        value={control.value}
        onChange={(event) => control.onChange(Number(event.target.value))}
      />
      <span className={styles.lsVal}>{control.format(control.value)}</span>
    </>
  )
}
