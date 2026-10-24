/**
 * 通过 GitHub REST API 推送（这台机器上 github.com:443 被挡，api.github.com 通）。
 *
 * 思路：本地每个 commit 的 tree 里的 blob sha 与 GitHub 完全一致（同一套 sha1 规则），
 * 所以只要把缺的 blob 用 API 建出来，再把原样的 tree 提交上去，GitHub 上的文件内容与
 * 本地逐字节一致，历史也能按 commit 逐个重建。
 *
 *   node scripts/push-github.mjs [owner/repo] [branch]
 */
import { execFileSync } from 'node:child_process'

const api = 'https://api.github.com'
const repo = process.argv[2] ?? 'Sh1D1nk/pineapple-music'
const branch = process.argv[3] ?? 'main'
const [owner, name] = repo.split('/')

function git(args, encoding) {
  return execFileSync('git', args, { encoding: encoding ?? 'utf8', maxBuffer: 1024 * 1024 * 256 })
}

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  const match = out.match(/^password=(.+)$/m)
  if (!match) throw new Error('没有可用的 GitHub 凭据（git credential fill 失败）')
  return match[1].trim()
}

const auth = token()

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pineapple-push'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// 0) 空仓库不允许直接建 blob：先用 Contents API 放一个占位文件，把仓库点着
const repoInfo = await call('GET', `/repos/${owner}/${name}`)
if (repoInfo.size === 0) {
  await call('PUT', `/repos/${owner}/${name}/contents/README.md`, {
    message: 'chore: init',
    content: Buffer.from('# Pineapple Music\n\n(该占位文件会被完整历史覆盖)\n').toString('base64')
  })
  console.log('空仓库：已用 Contents API 建立首个提交')
}

// 1) 收集所有 commit 需要用到的 blob
const commits = git(['rev-list', '--reverse', 'HEAD']).trim().split('\n')
console.log(`本地 ${commits.length} 个 commit，目标 ${owner}/${name}#${branch}`)

const created = new Set()
let total = 0
for (const commit of commits) {
  const entries = git(['ls-tree', '-r', commit])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t')
      const [mode, type, sha] = meta.split(/\s+/)
      return { mode, type, sha, path }
    })
  for (const entry of entries) {
    if (entry.type !== 'blob' || created.has(entry.sha)) continue
    const content = git(['cat-file', 'blob', entry.sha], 'buffer')
    await call('POST', `/repos/${owner}/${name}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64'
    })
    created.add(entry.sha)
    total += 1
    if (total % 20 === 0) console.log(`  已上传 ${total} 个 blob`)
  }
}
console.log(`blob 上传完成：${total} 个`)

// 2) 逐个 commit 重建 tree / commit
let parent = null
for (const commit of commits) {
  const message = git(['log', '-1', '--pretty=%B', commit])
  const tree = git(['rev-parse', `${commit}^{tree}`]).trim()
  const entries = git(['ls-tree', '-r', commit])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t')
      const [mode, type, sha] = meta.split(/\s+/)
      return { mode, type, sha, path }
    })
  const treeObj = await call('POST', `/repos/${owner}/${name}/git/trees`, {
    base_tree: parent ?? undefined,
    tree: entries
  })
  const commitObj = await call('POST', `/repos/${owner}/${name}/git/commits`, {
    message,
    tree: treeObj.sha,
    parents: parent ? [parent] : []
  })
  parent = commitObj.sha
  console.log(`  commit ${commit.slice(0, 7)} → ${commitObj.sha.slice(0, 7)}  ${message.split('\n')[0]}`)
}

// 3) 更新分支引用
try {
  await call('PATCH', `/repos/${owner}/${name}/git/refs/heads/${branch}`, { sha: parent, force: true })
  console.log(`已更新分支 ${branch}`)
} catch {
  await call('POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: parent })
  console.log(`已创建分支 ${branch}`)
}
console.log(`完成 → https://github.com/${owner}/${name}`)
