#!/usr/bin/env node
/**
 * 启动「正式构建、未打包」的产物：out/main + out/renderer。
 * 与 dev 的区别：React 生产构建、无 StrictMode、无 HMR、无 DevTools。
 *
 * 用法：npm run start:prod [-- --remote-debugging-port=9222]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const electron = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('缺少 out/：先运行 npm run compile')
  process.exit(1)
}
if (!existsSync(electron)) {
  console.error('缺少 electron 二进制：先 npm install')
  process.exit(1)
}
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.NODE_ENV
const args = [root, ...process.argv.slice(2)]
const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
