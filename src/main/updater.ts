/**
 * 更新检查：GitHub Releases（不下载、不静默安装）。
 *
 * 只做三件事：比对版本、把「有没有更新」告诉界面、需要时打开 Release 页面
 * 让用户自己下载安装包。这里不引入 autoUpdater —— 未签名的 NSIS 无法静默升级，
 * 反而会因为 UAC/签名产生更多问题。
 */
import { app, shell } from 'electron'
import { EventEmitter } from 'node:events'
import type { UpdateStatus } from '@shared/types'
import { compareVersions } from '@shared/versions'

export type { UpdateStatus }
export { compareVersions }

const REPO = 'Sh1D1nk/pineapple-music'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class UpdateService extends EventEmitter {
  private status: UpdateStatus
  private auto = true
  private timer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.status = {
      current: app.getVersion(),
      latest: null,
      hasUpdate: false,
      checking: false,
      checkedAt: null,
      error: null,
      releaseName: null,
      releaseUrl: null,
      publishedAt: null,
      notes: null,
      asset: null,
      repo: REPO,
      fake: false
    }
  }

  get(): UpdateStatus {
    return { ...this.status }
  }

  setAuto(enabled: boolean): void {
    this.auto = enabled
    if (!enabled && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 启动后延迟检查：别和首屏抢网络与主进程时间。 */
  scheduleInitialCheck(delayMs = 8000): void {
    if (!this.auto || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check(false)
    }, delayMs)
    this.timer.unref?.()
  }

  private patch(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.get())
    return this.get()
  }

  async check(force = false): Promise<UpdateStatus> {
    if (this.status.checking) return this.get()
    const fresh = this.status.checkedAt !== null && Date.now() - this.status.checkedAt < CHECK_INTERVAL_MS
    if (!force && fresh && !this.status.error) return this.get()
    if (!this.auto && !force) return this.get()

    this.patch({ checking: true, error: null })

    // 测试钩子：用 PINNET_UPDATE_FAKE=1.9.9 模拟「有更新」，方便验收界面
    const fake = process.env.PINNET_UPDATE_FAKE
    if (fake) {
      await sleep(350)
      const hasUpdate = compareVersions(fake, this.status.current) > 0
      return this.patch({
        checking: false,
        latest: fake,
        hasUpdate,
        fake: true,
        checkedAt: Date.now(),
        releaseName: `（测试数据）v${fake}`,
        releaseUrl: `https://github.com/${REPO}/releases`,
        publishedAt: new Date().toISOString(),
        notes: '这是 PINNET_UPDATE_FAKE 生成的假版本，仅用于验证更新提示。',
        asset: { name: `Pinnet-${fake}-setup.exe`, size: 180 * 1024 * 1024, url: `https://github.com/${REPO}/releases` }
      })
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: {
          'user-agent': `Pinnet/${this.status.current} (update-check)`,
          accept: 'application/vnd.github+json'
        },
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (response.status === 404) {
        return this.patch({
          checking: false,
          checkedAt: Date.now(),
          error: '仓库还没有发布 Release',
          hasUpdate: false,
          latest: null
        })
      }
      if (response.status === 403) {
        return this.patch({
          checking: false,
          checkedAt: Date.now(),
          error: 'GitHub API 限流，稍后再试',
          hasUpdate: false
        })
      }
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
      const release = (await response.json()) as {
        tag_name?: string
        name?: string
        html_url?: string
        published_at?: string
        body?: string
        assets?: { name: string; size: number; browser_download_url: string }[]
      }
      const latest = (release.tag_name ?? '').replace(/^v/i, '') || null
      if (!latest) throw new Error('Release 缺少 tag')
      const asset = (release.assets ?? []).find((entry) => /setup\.exe$/i.test(entry.name)) ?? (release.assets ?? [])[0] ?? null
      return this.patch({
        checking: false,
        latest,
        hasUpdate: compareVersions(latest, this.status.current) > 0,
        checkedAt: Date.now(),
        error: null,
        fake: false,
        releaseName: release.name ?? null,
        releaseUrl: release.html_url ?? `https://github.com/${REPO}/releases`,
        publishedAt: release.published_at ?? null,
        notes: release.body ? release.body.slice(0, 1600) : null,
        asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null
      })
    } catch (err) {
      const message = err instanceof Error ? (err.name === 'AbortError' ? '检查更新超时' : err.message) : String(err)
      return this.patch({ checking: false, checkedAt: Date.now(), error: message, hasUpdate: false })
    }
  }

  /** 「前往 GitHub 更新」：打开 Release 页面（不放行任意 URL）。 */
  async openRelease(): Promise<boolean> {
    const url = this.status.releaseUrl ?? `https://github.com/${REPO}/releases`
    try {
      const parsed = new URL(url)
      if (parsed.hostname !== 'github.com' || !parsed.pathname.startsWith(`/${REPO.split('/')[0]}/`)) return false
      await shell.openExternal(url)
      return true
    } catch {
      return false
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
