#!/usr/bin/env node
/**
 * 把 plugins/pinnet-bridge.js 注入汽水音乐。支持两种目标（幂等）：
 *
 * 1. 3.7.0（AMLL 时代）：追加到 resources/amll/soda-amll.js 末尾。
 * 2. 3.8.0+（bundle 化）：AMLL 组件被移除，renderer 是 main.asar 的 main.html +
 *    assets bundle；插件内联进 main.html，插在页面 module bundle 之前执行，
 *    以便包装 window.transportPort.receiveTransport 与页面共享消息流。
 *
 * 用法：node tools/install-pinnet-bridge.mjs [--38] [targetPath]
 *   默认自动探测：优先 Packages/<latest>/main.asar（3.8.0），否则 soda-amll.js（3.7.0）。
 * 重复运行会先剥掉旧注入再写新的；首次运行会留 .bak 备份。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

const MARK_START = '/* ==== PINNET BRIDGE (v1) ===='
const MARK_END = '/* ==== /PINNET BRIDGE ==== */'
const MARK38_OPEN = '<script>/* ==== PINNET BRIDGE (v2) ==== */'
const MARK38_CLOSE = '/* ==== /PINNET BRIDGE ==== */</script>'

const args = process.argv.slice(2)
const force38 = args.includes('--38')
const targetArg = args.find((a) => !a.startsWith('--'))

const base = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Soda Music')

function latestPackage() {
  if (!existsSync(base)) return null
  const pkgs = join(base, 'Packages')
  if (!existsSync(pkgs)) return null
  const versions = readdirSync(pkgs).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort()
  for (const version of versions.reverse()) {
    const file = join(pkgs, version, 'main.asar')
    if (existsSync(file)) return file
  }
  return null
}

function legacyAmllTarget() {
  if (!existsSync(base)) return null
  const versions = readdirSync(base).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort()
  for (const version of versions.reverse()) {
    const file = join(base, version, 'resources', 'amll', 'soda-amll.js')
    if (existsSync(file)) return file
  }
  return null
}

const bridge = readFileSync(join(import.meta.dirname, 'pinnet-bridge.js'), 'utf8')

/* ---------- 3.8.0：注入 main.html（需要解包/重打包 main.asar） ---------- */
async function install38(asarPath) {
  const work = mkdtempSync(join(tmpdir(), 'pinnet38-'))
  try {
    await asar.extractAll(asarPath, work)
    const htmlPath = join(work, 'main.html')
    if (!existsSync(htmlPath)) {
      console.error('main.asar 里没有 main.html，无法注入')
      process.exit(1)
    }
    let html = readFileSync(htmlPath, 'utf8')
    // 幂等：剥掉旧注入
    const s = html.indexOf(MARK38_OPEN)
    if (s >= 0) {
      const e = html.indexOf(MARK38_CLOSE, s)
      if (e >= 0) html = html.slice(0, s) + html.slice(e + MARK38_CLOSE.length)
    }
    const bundleTag = /<script type="module"[^>]*src="\.\/assets\/main-[^"]*\.js"><\/script>/
    if (!bundleTag.test(html)) {
      console.error('main.html 里找不到 module 入口 script，注入中止')
      process.exit(1)
    }
    const inline = `${MARK38_OPEN}\n${bridge}\n${MARK38_CLOSE}`
    html = html.replace(bundleTag, `${inline}\n$&`)
    const backup = `${asarPath}.bak-pinnet`
    if (!existsSync(backup)) copyFileSync(asarPath, backup)
    writeFileSync(htmlPath, html)
    await asar.createPackage(work, asarPath)
    console.log('bridge installed (3.8.0) ->', asarPath)
    console.log('backup:', backup)
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/* ---------- 3.7.0：追加 soda-amll.js ---------- */
function install37(target) {
  const original = readFileSync(target, 'utf8')
  let base37 = original
  const startAt = base37.indexOf(MARK_START)
  if (startAt >= 0) {
    const endAt = base37.indexOf(MARK_END, startAt)
    if (endAt >= 0) base37 = base37.slice(0, startAt) + base37.slice(endAt + MARK_END.length)
  }
  const backup = `${target}.bak-pinnet`
  if (!existsSync(backup)) copyFileSync(target, backup)
  writeFileSync(target, `${base37}\n\n${bridge}\n`)
  console.log('bridge installed (3.7.0) ->', target)
  console.log('backup:', backup)
}

/* ---------- 目标选择 ---------- */
const pkg = latestPackage()
const legacy = legacyAmllTarget()
if (force38 || (pkg && !targetArg)) { await (async () => {
  if (!pkg) {
    console.error('找不到 Packages/*/main.asar')
    process.exit(1)
  }
  await install38(targetArg ?? pkg)
})() } else {
  const target = targetArg ?? legacy
  if (!target || !existsSync(target)) {
    console.error('找不到 soda-amll.js；请把路径作为第一个参数传进来')
    process.exit(1)
  }
  install37(target)
}
