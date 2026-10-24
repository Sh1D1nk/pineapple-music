import { _electron as electron } from 'playwright'
import { resolve, join } from 'node:path'
const root = resolve('.')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
// 用法：node scripts/probe-packaged.mjs [dist-vXXX]（默认取最新的 dist-v* 目录）
const outDir = process.argv[2] ?? 'dist-v120'
const exe = join(root, outDir, 'win-unpacked', 'Pineapple Music.exe')
const app = await electron.launch({
  executablePath: exe,
  args: [`--user-data-dir=${process.env.TEMP}/lm-pkg-${Date.now()}`],
  env,
  timeout: 90000
})
const page = await app.firstWindow({ timeout: 60000 })
await page.waitForSelector('text=添加你的音乐', { timeout: 30000 })
await page.evaluate((dir) => window.lm.invoke('library/addFolder', dir), join(root, 'fixtures'))
await page.waitForFunction(async () => {
  const s = await window.lm.invoke('library/snapshot')
  return s.songs.length >= 10
}, { timeout: 60000 })
await page.waitForTimeout(6000)
const info = await page.evaluate(async () => {
  const s = await window.lm.invoke('library/snapshot')
  return { songs: s.songs.length, withCovers: s.songs.filter(x => x.coverId).length, hyalite: window.Hyalite?.version ?? null }
})
console.log('packaged app:', info)
await page.screenshot({ path: join(root, 'screenshots/26-packaged.png') })
await app.close()
