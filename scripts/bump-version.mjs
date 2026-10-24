/**
 * 版本号自动递增 + CHANGELOG 自动记录。
 *
 *   node scripts/bump-version.mjs [patch|minor|major] [--note "这次改了什么"]
 *
 * 规则：默认按 patch 递增；带 --note 时会写进 CHANGELOG 顶部。
 * 之后 `npm run release` = 递增版本号 → 构建安装包 → 提交并打标签，
 * 不用再手动回忆「这轮该叫几号」。
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve('.')
const args = process.argv.slice(2)
const type = (args.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch')
const noteIndex = args.indexOf('--note')
const note = noteIndex >= 0 ? (args[noteIndex + 1] ?? '') : ''

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const [major, minor, patch] = String(pkg.version).split('.').map((n) => Number(n) || 0)
const next =
  type === 'major'
    ? `${major + 1}.0.0`
    : type === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`

pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

// 汇总本轮改动：最近一次提交之后的变更
let summary = note
if (!summary) {
  try {
    summary = execSync('git log -1 --pretty=%s', { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    summary = '版本更新'
  }
}

const changelogPath = join(root, 'CHANGELOG.md')
const date = new Date().toISOString().slice(0, 10)
const entry = `## ${next} - ${date}\n\n- ${summary}\n`
const previous = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n'
const header = previous.startsWith('# Changelog')
  ? previous
  : '# Changelog\n\n'
const body = previous.replace(header, '')
writeFileSync(changelogPath, `${header}${entry}${body}`)

console.log(`版本号 ${pkg.version} → ${next}；CHANGELOG 已更新`)
