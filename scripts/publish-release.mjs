#!/usr/bin/env node
/**
 * 发版：把本地「v1.6.0 之后」的提交增量重建到 GitHub，打 tag，触发 Release Action，等安装包上传。
 *
 * 为什么不用 git push：这台机器 github.com:443 被挡，只有 api.github.com 通；
 * 远端历史是脚本重建过的（sha 与本地不同），所以从「tree 相同的那个本地提交」开始增量建。
 *
 *   node scripts/publish-release.mjs 1.7.0
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const api = 'https://api.github.com'
const repo = 'Sh1D1nk/pineapple-music'
const [owner, name] = repo.split('/')
const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!version) {
  console.error('用法：node scripts/publish-release.mjs 1.7.0')
  process.exit(1)
}
const tag = `v${version}`
const BASE_LOCAL = 'b997760' // v1.6.0：tree 与远端 main HEAD 一致（远端 sha 是重建出来的）

const git = (args, encoding = 'utf8') => execFileSync('git', args, { encoding, maxBuffer: 1024 * 1024 * 256 })

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
      'User-Agent': 'pineapple-release'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1) 对齐远端 HEAD 与本地 base（tree 必须逐字节一致）
const head = await call('GET', `/repos/${owner}/${name}/git/ref/heads/main`)
const remoteHead = head.object.sha
const remoteCommit = await call('GET', `/repos/${owner}/${name}/git/commits/${remoteHead}`)
const baseTree = git(['rev-parse', `${BASE_LOCAL}^{tree}`]).trim()
if (remoteCommit.tree.sha !== baseTree) {
  throw new Error(
    `远端 tree ${remoteCommit.tree.sha} 与本地 ${BASE_LOCAL} 的 tree ${baseTree} 不一致；` +
      `需要先人工确认基线（可能有人在网页上改过仓库）`
  )
}
console.log(`远端 main ${remoteHead.slice(0, 7)}（tree 与本地 ${BASE_LOCAL} 一致）`)

const commits = git(['rev-list', '--reverse', `${BASE_LOCAL}..HEAD`]).trim().split('\n').filter(Boolean)
if (commits.length === 0) throw new Error('没有需要发布的提交')
console.log(`待发布 ${commits.length} 个提交`)

// ---- 2) 逐提交重建 blob / tree / commit
const createdBlobs = new Set()
let parentSha = remoteHead
let parentTree = remoteCommit.tree.sha

for (const commit of commits) {
  const message = git(['log', '-1', '--pretty=%B', commit]).trimEnd()
  const changes = git(['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', `${commit}^`, commit])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, path: rest.join('\t') }
    })

  const tree = []
  for (const change of changes) {
    if (change.status.startsWith('D')) {
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = git(['rev-parse', `${commit}:${change.path}`]).trim()
    if (!createdBlobs.has(blob)) {
      const content = git(['cat-file', 'blob', blob], 'buffer')
      await call('POST', `/repos/${owner}/${name}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64'
      })
      createdBlobs.add(blob)
      console.log(`  blob ${blob.slice(0, 7)} ${change.path} (${Math.round(content.length / 1024)} KB)`)
    }
    const mode = git(['ls-tree', commit, '--', change.path]).trim().split(/\s+/)[0] ?? '100644'
    tree.push({ path: change.path, mode, type: 'blob', sha: blob })
  }

  const newTree = await call('POST', `/repos/${owner}/${name}/git/trees`, { base_tree: parentTree, tree })
  const newCommit = await call('POST', `/repos/${owner}/${name}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [parentSha]
  })
  console.log(`  commit ${commit.slice(0, 7)} → ${newCommit.sha.slice(0, 7)}  ${message.split('\n')[0]}`)
  parentSha = newCommit.sha
  parentTree = newTree.sha
}

await call('PATCH', `/repos/${owner}/${name}/git/refs/heads/main`, { sha: parentSha, force: true })
console.log(`main 已更新 → ${parentSha.slice(0, 7)}`)

// ---- 3) tag
try {
  await call('POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/tags/${tag}`, sha: parentSha })
  console.log(`已创建 tag ${tag}`)
} catch (err) {
  if (String(err).includes('422')) {
    console.log(`tag ${tag} 已存在，改为指向新提交`)
    await call('PATCH', `/repos/${owner}/${name}/git/refs/tags/${tag}`, { sha: parentSha, force: true })
  } else throw err
}

// ---- 4) 触发 Release Action
const dispatchAt = Date.now()
await call('POST', `/repos/${owner}/${name}/actions/workflows/release.yml/dispatches`, {
  ref: 'main',
  inputs: { tag }
})
console.log(`已触发 Release Action（tag=${tag}），等 Windows 构建…`)

let runId = null
for (let i = 0; i < 40 && !runId; i++) {
  await sleep(8000)
  const runs = await call('GET', `/repos/${owner}/${name}/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=5`)
  const run = (runs.workflow_runs ?? []).find((entry) => new Date(entry.created_at).getTime() >= dispatchAt - 60_000)
  if (run) runId = run.id
}
if (!runId) throw new Error('没有找到刚触发的 Action run')
console.log(`Action run ${runId}：https://github.com/${repo}/actions/runs/${runId}`)

let conclusion = null
for (let i = 0; i < 120; i++) {
  await sleep(15000)
  const run = await call('GET', `/repos/${owner}/${name}/actions/runs/${runId}`)
  if (run.status === 'completed') {
    conclusion = run.conclusion
    break
  }
  if (i % 4 === 0) console.log(`  构建中… ${run.status} / ${run.conclusion ?? '…'}`)
}
if (conclusion !== 'success') throw new Error(`Action 失败：${conclusion}`)
console.log('构建成功，等 Release 资产…')

// ---- 5) 等资产 + 写 release notes
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const match = changelog.match(new RegExp(`## ${version.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`))
const notes = match ? match[1].trim() : ''

let release = null
for (let i = 0; i < 40; i++) {
  await sleep(10000)
  try {
    const candidate = await call('GET', `/repos/${owner}/${name}/releases/tags/${tag}`)
    const asset = (candidate.assets ?? []).find((entry) => /setup\.exe$/i.test(entry.name))
    if (asset && asset.size > 10 * 1024 * 1024) {
      release = candidate
      break
    }
  } catch {
    /* release 还没建出来 */
  }
}
if (!release) throw new Error('Release 或安装包资产没有出现')
if (notes) {
  await call('PATCH', `/repos/${owner}/${name}/releases/${release.id}`, {
    body: `Pineapple Music v${version}\n\n${notes}`,
    name: `Pineapple Music v${version}`
  })
}
const asset = release.assets.find((entry) => /setup\.exe$/i.test(entry.name))
console.log(`\n发布完成：${release.html_url}`)
console.log(`安装包：${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）`)
console.log(`更新检查会看到最新版 v${version}`)
