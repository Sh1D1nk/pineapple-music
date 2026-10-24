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

/** 具体模型页：不是搜索页，点开就能看到文件与 LICENSE。许可以各仓库说明为准，应用不内置模型。 */
const MODEL_SOURCES: { name: string; url: string; note: string }[] = [
  {
    name: 'UVR5 / Demucs ONNX 镜像（Hugging Face）',
    url: 'https://huggingface.co/Tha456/uvr5-models',
    note: 'UVR_MDXNET_3_9662.onnx 约 28 MB · UVR_MDXNET_Main.onnx 约 64 MB · MIT，随模型附 .LICENSE'
  },
  {
    name: 'MDX-Net 模型目录（Hugging Face）',
    url: 'https://huggingface.co/Politrees/UVR_resources/tree/main/MDXNet_models',
    note: 'UVR-MDX-NET-Voc_FT.onnx 约 67 MB · 许可见仓库说明'
  },
  {
    name: 'UVR 官方模型库（GitHub Releases）',
    url: 'https://github.com/TRvlvr/model_repo/releases',
    note: '上游发布页 · MIT · 本机直连 github.com 可能被挡，可用上面的镜像'
  }
]

/** 分轨模型状态：显示装了什么、从哪下、怎么导入。 */
function ModelSection(): JSX.Element {
  const [status, setStatus] = useState<{
    dir: string
    files: { name: string; size: number }[]
    rejected: { name: string; reason: string }[]
    installed: boolean
    url: string
  } | null>(null)
  const [stems, setStems] = useState<Awaited<ReturnType<typeof bridge.stems.status>> | null>(null)
  const [importError, setImportError] = useState<{ reason: string; expected?: string; actual?: string | null } | null>(null)
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

      <div className={styles.guide}>
        <div className={styles.guideTitle}>这个模型是干什么的</div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>用途</span>
          <span className={styles.guideValue}>
            把歌曲拆成 <code>vocals</code>（人声）与 <code>instrumental</code>（伴奏）两轨，供 AutoMix 的 A / B 级过渡使用。
            不装模型时 AutoMix 降级为 C 级（整曲节拍对齐 + 低频交换），播放本身不受影响。
          </span>
        </div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>格式</span>
          <span className={styles.guideValue}>
            ONNX，<b>频谱 mask 家族</b>（UVR / MDX-Net 系导出）。输入输出同形状 <code>[1, C, 2049, T]</code>，
            C = 2（立体声实虚）或 4（+ 单声道），前两通道当 L / R mask；STFT 固定 n_fft=4096 / hop=1024。
          </span>
        </div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>不兼容</span>
          <span className={styles.guideValue}>
            不支持 4-stem（鼓 / 贝斯 / 和声分离）、不支持波形域模型（WaveGAN 一类）、不支持 GPU Execution Provider；
            频点数不是 2049 的导出（例如 <code>[1, 4, 3072, 256]</code>）也会被拒绝。
          </span>
        </div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>存放位置</span>
          <span className={styles.guideValue}>
            <span className={styles.pathBox}>{status?.dir ?? '%APPDATA%\\Pineapple Music\\models\\'}</span>
            <span className={styles.guideActions}>
              <button type="button" className={styles.segment} onClick={() => void bridge.models.reveal()}>
                打开模型目录
              </button>
            </span>
          </span>
        </div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>来源</span>
          <span className={styles.guideValue}>
            {MODEL_SOURCES.map((source) => (
              <span key={source.url} className={styles.sourceRow}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => void bridge.openExternal(source.url)}
                  title={source.url}
                >
                  {source.name}
                </button>
                <span className={styles.sourceNote}>{source.note}</span>
              </span>
            ))}
            <span className={styles.sourceNote}>
              应用不内置、不转分发任何模型；下载前请自行确认模型页上的许可与体积。
            </span>
          </span>
        </div>
        <div className={styles.guideRow}>
          <span className={styles.guideLabel}>获取方式</span>
          <span className={styles.guideValue}>
            <ol className={styles.steps}>
              <li>点上面的来源链接，下载一个 <code>.onnx</code> 文件</li>
              <li>点「导入本地模型…」选中它（会自动复制进模型目录），或手动丢进「打开模型目录」</li>
              <li>本区块状态变成「已安装」，并显示文件名与大小</li>
              <li>必要时点「开始分轨（当前 + 下一首）」预热，之后 AutoMix 才会走 A / B 级</li>
            </ol>
          </span>
        </div>
      </div>

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
          (level
            ? `按 ${level} 级规划`
            : status?.installed
              ? '等待播放与队列中出现下一首'
              : '未安装分轨模型：现在固定走 C 级，装好后可升到 A / B 级')
        }
      >
        <span className={styles.statValue} style={{ fontSize: 15 }}>
          {automix === 'ready' || automix === 'entering' ? (level ?? '—') : automix === 'rendering' ? '渲染中' : '待命'}
        </span>
      </Row>
      {status && status.rejected.length > 0 && (
        <div className={styles.guide}>
          <div className={styles.guideTitle}>签名不兼容的模型</div>
          {status.rejected.map((entry) => (
            <div key={entry.name} className={styles.rejectRow}>
              <span className={styles.rejectName}>{entry.name}</span>
              <span className={styles.rejectReason}>{entry.reason}</span>
            </div>
          ))}
        </div>
      )}
      {importError && (
        <div className={styles.guide}>
          <div className={styles.guideTitle}>上次导入失败</div>
          <div className={styles.rejectReason}>{importError.reason}</div>
          {(importError.expected || importError.actual) && (
            <div className={styles.rejectReason}>
              期望 {importError.expected ?? '—'} · 实际 {importError.actual ?? '读不到输入形状'}
            </div>
          )}
        </div>
      )}
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
              setImportError(null)
              pushToast(`已导入 ${result.name ?? '模型'}`)
              refresh()
            } else if (result.reason && result.reason !== 'canceled') {
              setImportError({ reason: result.reason, expected: result.expected, actual: result.actual })
              pushToast('模型签名不兼容，详见下方原因')
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
          <button
            type="button"
            className={styles.segmentActive}
            style={{ height: 30, borderRadius: 8 }}
            onClick={async () => {
              const added = await bridge.pickFolder()
              if (added && added.length > 0) {
                useStore.getState().pushToast(`已添加 ${added.length} 个文件夹`)
              }
            }}
          >
            添加音乐文件夹…
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.rescan()}>
            重新扫描
          </button>
          <button type="button" className={styles.segment} style={{ height: 30 }} onClick={() => void bridge.openUserData()}>
            打开缓存目录
          </button>
        </div>
        <div className={styles.note}>
          添加后会立即开始扫描，已入库的歌曲可以边扫边播。移除文件夹只影响索引，不会删除磁盘上的文件。
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
        <Row label="歌词字体" hint="优先使用本机苹方字体">
          <Segmented
            value={settings.lyricFont}
            options={[
              { value: 'pingfang', label: '苹方' },
              { value: 'system', label: '跟随系统' }
            ]}
            onChange={(value) => void update({ lyricFont: value })}
          />
        </Row>
        <Row label="点击歌词跳转" hint="点击歌词行跳到对应播放位置">
          <Switch value={settings.lyricClickSeek} onChange={(value) => void update({ lyricClickSeek: value })} />
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
        <Row label="歌词粗细" hint="歌词文字的笔画粗细，默认半粗 600">
          <Segmented
            value={String(settings.lyricWeight)}
            options={[
              { value: '300', label: '细' },
              { value: '400', label: '常规' },
              { value: '500', label: '中黑' },
              { value: '600', label: '半粗' },
              { value: '700', label: '粗' }
            ]}
            onChange={(value) => void update({ lyricWeight: Number(value) })}
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
        <div className={styles.sectionTitle}>歌词播放器</div>
        <Row label="歌词界面过渡动画" hint="进入 / 退出时的下拉与淡入缓动">
          <Switch value={settings.lyricTransition} onChange={(value) => void update({ lyricTransition: value })} />
        </Row>
        <Row label="切歌按钮动画" hint="上一首 / 下一首按钮的 Q 弹按压动画">
          <Switch value={settings.btnAnim} onChange={(value) => void update({ btnAnim: value })} />
        </Row>
        <Row label="封面与背景过渡" hint="切歌时封面与背景交叉淡入">
          <Switch value={settings.mediaAnim} onChange={(value) => void update({ mediaAnim: value })} />
        </Row>
        <Row label="歌词模糊效果" hint="非当前行模糊处理（AMLL）">
          <Switch value={settings.lyricBlur} onChange={(value) => void update({ lyricBlur: value })} />
        </Row>
        <Row label="歌词缩放效果" hint="非当前行轻微缩小（AMLL）">
          <Switch value={settings.lyricScale} onChange={(value) => void update({ lyricScale: value })} />
        </Row>
        <Row label="逐字渐变宽度" hint="默认 0.60，模拟 Apple Music 的逐字擦除">
          <Slider
            value={settings.wordFade}
            min={0.05}
            max={1.5}
            step={0.05}
            onChange={(value) => void update({ wordFade: value })}
          />
        </Row>
        <Row label="隐藏已播放歌词" hint="已播放的歌词行淡出隐藏">
          <Switch value={settings.hidePassed} onChange={(value) => void update({ hidePassed: value })} />
        </Row>
        <Row label="显示帧率" hint="在歌词页右上角显示实时帧率">
          <Switch value={settings.showFps} onChange={(value) => void update({ showFps: value })} />
        </Row>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>歌词源</div>
        <Row label="来源优先级" hint="按顺序尝试：外挂文件 → 内嵌标签 → 纯文本">
          <Segmented
            value={settings.lyricsPriority[0] ?? 'sidecar'}
            options={[
              { value: 'sidecar', label: '外挂优先' },
              { value: 'embedded', label: '内嵌优先' }
            ]}
            onChange={(value) =>
              void update({
                lyricsPriority:
                  value === 'sidecar' ? ['sidecar', 'embedded', 'text'] : ['embedded', 'sidecar', 'text']
              })
            }
          />
        </Row>
        <Row label="自动回退" hint="当前来源取不到歌词时自动换下一个来源">
          <Switch value={settings.lyricAutoFallback} onChange={(value) => void update({ lyricAutoFallback: value })} />
        </Row>
        <div className={styles.note}>
          外挂来源支持 .lrc / .ttml / .lys / .yrc / .qrc；内嵌来源读取 SYLT / USLT / ©lyr / LYRICS；纯文本按静态列表显示。
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>背景</div>
        <Row label="显示歌词背景" hint="使用当前专辑封面作为背景">
          <Switch value={settings.bgEnabled} onChange={(value) => void update({ bgEnabled: value })} />
        </Row>
        <Row label="背景类型" hint="流体取色 / 模糊封面 / 深色渐变">
          <Segmented
            value={settings.bgType}
            options={[
              { value: 'flow', label: '流体背景' },
              { value: 'blur', label: '模糊封面' },
              { value: 'solid', label: '深色渐变' }
            ]}
            onChange={(value) => void update({ bgType: value })}
          />
        </Row>
        <Row label="流体速度" hint="颜色流动的快慢">
          <Slider
            value={settings.bgFlowSpeed}
            min={0.1}
            max={4}
            step={0.05}
            onChange={(value) => void update({ bgFlowSpeed: value })}
          />
        </Row>
        <Row label="渲染精度" hint="越低越省性能">
          <Slider
            value={settings.bgRenderScale}
            min={0.2}
            max={1}
            step={0.05}
            onChange={(value) => void update({ bgRenderScale: value })}
          />
        </Row>
        <Row label="渲染帧率" hint="0 为静止">
          <Slider
            value={settings.bgFps}
            min={0}
            max={60}
            step={1}
            onChange={(value) => void update({ bgFps: value })}
          />
        </Row>
        <Row label="背景模糊" hint="模糊封面模式下的柔和程度">
          <Slider
            value={settings.bgBlur}
            min={0}
            max={200}
            step={2}
            onChange={(value) => void update({ bgBlur: value })}
          />
        </Row>
        <Row label="背景亮度">
          <Slider
            value={settings.bgBrightness}
            min={0.15}
            max={1.2}
            step={0.01}
            onChange={(value) => void update({ bgBrightness: value })}
          />
        </Row>
        <Row label="背景饱和度">
          <Slider
            value={settings.bgSaturate}
            min={0.5}
            max={3}
            step={0.05}
            onChange={(value) => void update({ bgSaturate: value })}
          />
        </Row>
        <Row label="性能模式" hint="降低背景分辨率与帧率，并关闭歌词模糊与缩放">
          <Switch value={settings.bgPerf} onChange={(value) => void update({ bgPerf: value })} />
        </Row>
        <Row label="自适应画质" hint="帧率偏低时自动下调背景渲染精度，帧率恢复后缓慢回升">
          <Switch
            value={settings.adaptiveQuality}
            onChange={(value) => void update({ adaptiveQuality: value })}
          />
        </Row>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>歌曲信息</div>
        <Row label="显示专辑名" hint="在歌手下方显示所属专辑">
          <Switch value={settings.showAlbum} onChange={(value) => void update({ showAlbum: value })} />
        </Row>
        <Row label="封面悬停隐藏鼠标" hint="鼠标移到专辑封面上时隐藏指针">
          <Switch value={settings.coverHideCursor} onChange={(value) => void update({ coverHideCursor: value })} />
        </Row>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>顶栏材质</div>
        <Row label="顶栏样式" hint="播放栏半透明效果">
          <Segmented
            value={settings.barStyle}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'blur', label: '模糊' }
            ]}
            onChange={(value) => void update({ barStyle: value })}
          />
        </Row>
        <Row label="不透明度" hint="数值越低越通透">
          <Slider
            value={settings.barOpacity}
            min={0.05}
            max={0.9}
            step={0.01}
            onChange={(value) => void update({ barOpacity: value })}
          />
        </Row>
        <Row label="模糊强度" hint="backdrop-filter 模糊半径">
          <Slider
            value={settings.barBlur}
            min={0}
            max={60}
            step={1}
            onChange={(value) => void update({ barBlur: value })}
          />
        </Row>
        <Row label="封面映射强度" hint="顶栏透出专辑封面">
          <Slider
            value={settings.barCover}
            min={0}
            max={0.9}
            step={0.01}
            onChange={(value) => void update({ barCover: value })}
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
