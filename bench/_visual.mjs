import { _electron as electron } from 'playwright'
import { join } from 'node:path'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.PINNET_USER_DATA = join(process.env.TEMP, 'pinnet-visual')
env.PINNET_NO_MIGRATE = '1'
env.PINNET_BENCH = '1'
const tag = process.argv[2] ?? 'after'
const app = await electron.launch({ args: [process.cwd()], env, timeout: 120000 })
const page = await app.firstWindow()
await page.waitForFunction(() => window.__store && window.__store.getState().ready, null, { timeout: 60000 })
// 固定截图条件：深色主题、悬浮玻璃底栏、关转场与性能 HUD，避免动画/浮层干扰
await page.evaluate(async () => {
  await window.__store.getState().updateSettings({
    theme: 'dark', controlBar: 'float', glass: 'full',
    pageTransition: false, showFps: false, backgroundProcessing: 'off'
  })
})
await page.waitForTimeout(800)

async function shot(name, view) {
  if (view) {
    await page.evaluate((v) => window.__store.getState().setView(v), view)
    await page.waitForTimeout(700)
  }
  await page.screenshot({ path: `perf/visual-${tag}-${name}.png` })
  console.log('shot', name, await page.evaluate(() => window.__store.getState().view.kind))
}

await shot('songs', { kind: 'songs' })
await shot('albums', { kind: 'albums' })
// 找一个真实专辑进入详情
const albumKey = await page.evaluate(() => {
  const s = window.__store.getState()
  const id = s.songIds.find((x) => s.songs[x] && s.songs[x].album)
  return id ? (s.songs[id].albumArtist + '\u0001' + s.songs[id].album) : null
})
if (albumKey) await shot('album-detail', { kind: 'album', key: albumKey })
await shot('settings', { kind: 'settings' })
await app.close()
