#!/usr/bin/env node
/**
 * 把 plugins/pinnet-bridge.js 追加到汽水音乐的 soda-amll.js 里（幂等）。
 *
 * 用法：node tools/install-pinnet-bridge.mjs [sodaAmllPath]
 * 默认路径：%LOCALAPPDATA%\Programs\Soda Music\<version>\resources\amll\soda-amll.js
 *
 * 为什么直接改产物：插件的源码工程不在本机，只有 esbuild 打包后的单文件。
 * 追加的段落被 PINNET BRIDGE 标记包住，重复运行会先剥掉旧段落再写新的，
 * 第一次运行会留一份 .bak-pinnet 备份。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MARK_START = '/* ==== PINNET BRIDGE (v1) ===='
const MARK_END = '/* ==== /PINNET BRIDGE ==== */'

function defaultTarget() {
  const base = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Soda Music')
  if (!existsSync(base)) return null
  const versions = readdirSync(base).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort()
  for (const version of versions.reverse()) {
    const file = join(base, version, 'resources', 'amll', 'soda-amll.js')
    if (existsSync(file)) return file
  }
  return null
}

const target = process.argv[2] ?? defaultTarget()
if (!target || !existsSync(target)) {
  console.error('找不到 soda-amll.js；请把路径作为第一个参数传进来')
  process.exit(1)
}

const bridge = readFileSync(join(import.meta.dirname, 'pinnet-bridge.js'), 'utf8')
const original = readFileSync(target, 'utf8')

// 剥掉旧段落（幂等）
let base = original
const startAt = base.indexOf(MARK_START)
if (startAt >= 0) {
  const endAt = base.indexOf(MARK_END, startAt)
  if (endAt >= 0) base = base.slice(0, startAt) + base.slice(endAt + MARK_END.length)
}

const backup = `${target}.bak-pinnet`
if (!existsSync(backup)) copyFileSync(target, backup)

writeFileSync(target, `${base}\n\n${bridge}\n`)
console.log('bridge installed ->', target)
console.log('backup:', backup)
