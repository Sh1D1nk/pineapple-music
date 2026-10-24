import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { useAutoMix } from '../audio/automix'
import { useGlass } from '../glass/GlassProvider'
import { bridge } from '../bridge'
import { Icon } from '../components/Icon'
import styles from '../components/settings.module.css'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className={styles.row}>
      <div>
        <div className={styles.rowLabel}>{label}</div>
        {hint && <div className={styles.rowHint}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <div className={styles.segmented}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-segment={option.value}
          className={`${styles.segment} ${value === option.value ? styles.segmentActive : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Switch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.switch} ${value ? styles.switchOn : ''}`}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
    >
      <span className={styles.knob} />
    </button>
  )
}

function Slider({
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange
}: {
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <div className={styles.sliderRow}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className={styles.value}>
        {value}
        {suffix ?? ''}
      </span>
    </div>
  )
}

/** 分轨模型状态：显示装了什么、从哪下、怎么导入。 */
function ModelSection(): JSX.Element {
  const [status, setStatus] = useState<{
    dir: string
    files: { name: string; size: number }[]
    installed: boolean
    url: string
  } | null>(null)
  const [stems, setStems] = useState<Awaited<ReturnType<typeof bridge.stems.status>> | null>(null)
  const automix = useAutoMix((s) => s.status)
  const level = useAutoMix((s) => s.level)
  const message = useAutoMix((s) => s.message)
  const pushToast = useStore((s) => s.pushToast)

  const refresh = (): void => {
    void bridge.models.status().then(setStatus)
    void bridge.stems.status().then(setStems)
  }
  useEffect(() => {
    refresh()
    return bridge.on('stems/progress', () => {
      void bridge.stems.status().then(setStems)
    })
  }, [])

  const progress = stems?.progress
  const running = Boolean(progress?.active)

  const installedText = !status
    ? '读取中…'
    : status.installed
      ? `${status.files[0]!.name} · ${(status.files[0]!.size / 1024 / 1024).toFixed(0)} MB`
      : '未安装'

  return (
    <>
      <Row
        label="分轨模型"
        hint={`把 vocal / instrumental 两轨 ONNX 放进模型目录即可解锁 A/B 级。当前模型：${installedText}`}
      >
        <span className={styles.statValue} style={{ fontSize: 13 }}>
          {status?.installed ? '已安装' : '未安装'}
        </span>
      </Row>
      <Row
        label="推理运行时"
        hint={
          stems?.runtime === 'onnxruntime-node'
            ? `onnxruntime-node 已就绪 · 可用模型 ${stems.models} 个 · 输出为频谱 mask 的两轨模型`
            : (stems?.reason ?? '正在检测 onnxruntime-node…')
        }
      >
        <span className={styles.statValue} style={{ fontSize: 13 }}>
          {stems?.runtime === 'onnxruntime-node' ? '可用' : '不可用'}
        </span>
      </Row>
      <Row
        label="分轨进度"
        hint={
          running
            ? `${progress?.stage === 'decode' ? '解码中' : progress?.stage === 'write' ? '写盘中' : '推理中'} · ${progress?.title ?? ''} · 队列 ${progress?.queued ?? 0}`
            : progress?.error
              ? `上次失败：${progress.error}`
              : progress?.lastSeconds
                ? `上次完成耗时 ${progress.lastSeconds} 秒`
                : '还没有跑过分轨'
        }
      >
        <span className={styles.statValue} style={{ fontSize: 13 }}>
          {running ? `${Math.round((progress?.percent ?? 0) * 100)}%` : '待命'}
        </span>
      </Row>
      <Row
        label="当前过渡级别"
        hint={
          message ??
          (level ? `按 ${level} 级规划` : '等待播放与队列中出现下一首')
        }
      >
        <span className={styles.statValue} style={{ fontSize: 15 }}>
          {automix === 'ready' || automix === 'entering' ? (level ?? '—') : automix === 'rendering' ? '渲染中' : '待命'}
        </span>
      </Row>
      <div className={styles.buttonRow}>
        <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.models.openPage()}>
          下载模型…
        </button>
        <button
          type="button"
          className={styles.segment}
          style={{ height: 30 }}
          onClick={async () => {
            const result = await bridge.models.import()
            if (result.ok) {
              pushToast(`已导入 ${result.name ?? '模型'}`)
              refresh()
            }
          }}
        >
          导入本地模型…
        </button>
        <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.models.reveal()}>
          打开模型目录
        </button>
      </div>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.segmentActive}
          style={{ height: 30, borderRadius: 8 }}
          disabled={!stems?.ready || running}
          onClick={() => {
            const state = useStore.getState()
            const current = state.playback.queue[state.playback.index]?.songId
            const next = state.playback.queue[state.playback.index + 1]?.songId
            const ids = [current, next].filter((id): id is string => Boolean(id))
            void bridge.stems.enqueue(ids)
          }}
        >
          开始分轨（当前 + 下一首）
        </button>
        <button
          type="button"
          className={styles.segment}
          style={{ height: 30 }}
          onClick={() => void (running ? bridge.stems.pause() : bridge.stems.resume())}
        >
          {running ? '暂停' : '继续'}
        </button>
        <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.stems.cancel()}>
          停止
        </button>
      </div>
    </>
  )
}

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const folders = useStore((s) => s.folders)
  const glass = useGlass()

  const automix = settings.automix
  const patchAutomix = (patch: Partial<typeof automix>): void => {
    void update({ automix: { ...automix, ...patch } })
  }

  return (
    <div className={styles.page}>
      <h1 className="pageTitle" style={{ marginBottom: 22 }}>
        设置
      </h1>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>外观</div>
        <Row label="主题">
          <Segmented
            value={settings.theme}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' }
            ]}
            onChange={(theme) => void update({ theme })}
          />
        </Row>
        <Row
          label="液态玻璃"
          hint={`当前生效：${
            glass.effective === 'full' ? '完整折射' : glass.effective === 'lite' ? '简化（磨砂 + 高光边）' : '关闭'
          }${glass.degraded ? ` · ${glass.degraded}` : ''}${
            glass.degraded ? '（再点一次「完整折射」可重试）' : ''
          }`}
        >
          <Segmented
            value={settings.glass}
            options={[
              { value: 'full', label: '完整折射' },
              { value: 'lite', label: '简化' },
              { value: 'off', label: '关闭' }
            ]}
            onChange={(value) => {
              if (value === 'full') glass.resetDegrade()
              void update({ glass: value })
            }}
          />
        </Row>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>资料库</div>
        {folders.length === 0 && <div className={styles.status}>还没有音乐文件夹</div>}
        {folders.map((folder) => (
          <div key={folder.path} className={styles.folderRow}>
            <span className={styles.folderPath}>{folder.path}</span>
            <button
              type="button"
              className={styles.segment}
              onClick={async () => {
                await bridge.removeFolder(folder.path)
                useStore.getState().pushToast('已移除文件夹')
              }}
            >
              移除
            </button>
          </div>
        ))}
        <div className={styles.buttonRow}>
          <button type="button" className={styles.segmentActive} style={{ height: 30, borderRadius: 8 }} onClick={() => void bridge.pickFolder()}>
            添加文件夹…
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.rescan()}>
            重新扫描
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.openUserData()}>
            打开缓存目录
          </button>
        </div>
        <div className={styles.note}>
          索引使用 better-sqlite3；若原生模块不可用会自动回退到 JSON 索引，功能不受影响。扫描按修改时间与文件大小增量执行，已入库的歌曲立即可播放。
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>歌词</div>
        <Row label="来源优先级" hint="同名外挂歌词优先于内嵌；纯文本歌词按静态列表显示">
          <Segmented
            value={settings.lyricsPriority[0] ?? 'sidecar'}
            options={[
              { value: 'sidecar', label: '外挂优先' },
              { value: 'embedded', label: '内嵌优先' }
            ]}
            onChange={(value) =>
              void update({ lyricsPriority: value === 'sidecar' ? ['sidecar', 'embedded'] : ['embedded', 'sidecar'] })
            }
          />
        </Row>
        <Row label="显示翻译">
          <Switch value={settings.showTranslation} onChange={(value) => void update({ showTranslation: value })} />
        </Row>
        <Row label="显示音译">
          <Switch value={settings.showRoman} onChange={(value) => void update({ showRoman: value })} />
        </Row>
        <Row label="歌词字号" hint="逐字歌词的基准字号倍数">
          <Slider
            value={Math.round(settings.lyricFontScale * 100)}
            min={80}
            max={130}
            step={5}
            suffix="%"
            onChange={(value) => void update({ lyricFontScale: value / 100 })}
          />
        </Row>
        <Row label="歌词粗细" hint="Apple Music 默认 600，越轻越纤细">
          <Slider
            value={settings.lyricWeight}
            min={200}
            max={900}
            step={50}
            onChange={(value) => void update({ lyricWeight: value })}
          />
        </Row>
        <Row label="歌词高光" hint="当前句已唱部分的亮度，越大越亮">
          <Slider
            value={settings.lyricHighlight}
            min={0.3}
            max={1.4}
            step={0.05}
            onChange={(value) => void update({ lyricHighlight: value })}
          />
        </Row>
        <Row label="歌词偏移" hint="正值让歌词提前显示">
          <Slider
            value={settings.lyricOffsetMs}
            min={-2000}
            max={2000}
            step={50}
            suffix=" ms"
            onChange={(value) => void update({ lyricOffsetMs: value })}
          />
        </Row>
        <Row label="动态背景质量">
          <Segmented
            value={settings.backgroundQuality}
            options={[
              { value: 'high', label: '高 60fps' },
              { value: 'medium', label: '中 30fps' },
              { value: 'low', label: '静态' },
              { value: 'off', label: '关闭' }
            ]}
            onChange={(value) => void update({ backgroundQuality: value })}
          />
        </Row>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>播放 · AutoMix</div>
        <Row label="自动衔接" hint="关闭后所有切歌都使用短交叉淡化">
          <Switch value={automix.enabled} onChange={(value) => patchAutomix({ enabled: value })} />
        </Row>
        <Row label="过渡时长">
          <Slider value={automix.durationSec} min={8} max={45} suffix=" 秒" onChange={(value) => patchAutomix({ durationSec: value })} />
        </Row>
        <Row label="最大变速幅度" hint="硬上限 ±12%">
          <Slider value={automix.maxRatePct} min={1} max={12} suffix=" %" onChange={(value) => patchAutomix({ maxRatePct: value })} />
        </Row>
        <Row label="保护当前歌曲末句人声">
          <Switch value={automix.protectLastPhrase} onChange={(value) => patchAutomix({ protectLastPhrase: value })} />
        </Row>
        <Row label="基础淡入淡出" hint="降级到 D 级时使用">
          <Slider value={automix.baseFadeSec} min={2} max={12} suffix=" 秒" onChange={(value) => patchAutomix({ baseFadeSec: value })} />
        </Row>
        <Row label="分轨模式" hint="需要分轨模型；未安装时自动降级为 C 级（整曲节拍对齐）">
          <Segmented
            value={automix.stems ? 'on' : 'off'}
            options={[
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' }
            ]}
            onChange={(value) => patchAutomix({ stems: value === 'on' })}
          />
        </Row>
        <Row label="分轨预处理">
          <Segmented
            value={automix.preprocess}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'smart', label: '智能' },
              { value: 'all', label: '全库' }
            ]}
            onChange={(value) => patchAutomix({ preprocess: value })}
          />
        </Row>
        <Row label="后台线程上限">
          <Slider value={automix.workerLimit} min={1} max={8} onChange={(value) => patchAutomix({ workerLimit: value })} />
        </Row>
        <Row label="仅接通电源时分轨">
          <Switch value={automix.onlyOnAC} onChange={(value) => patchAutomix({ onlyOnAC: value })} />
        </Row>
        <Row label="缓存上限">
          <Slider value={automix.cacheLimitGB} min={1} max={50} suffix=" GB" onChange={(value) => patchAutomix({ cacheLimitGB: value })} />
        </Row>
        <ModelSection />
        <div className={styles.note}>
          没有分轨模型时，AutoMix 走 C 级（整曲节拍对齐 + 低频交换）；拍点不可靠才降到 D 级（等功率交叉淡化），同专辑连续曲目走 E 级无缝。
          降级全程不影响正常播放。
        </div>
        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.segment}
            style={{ height: 30 }}
            onClick={() => useStore.getState().setView({ kind: 'lab' })}
          >
            <Icon name="waveform" size={13} /> 打开 Transition Lab
          </button>
        </div>
      </section>
    </div>
  )
}
