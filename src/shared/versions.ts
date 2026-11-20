/** 版本号比较（semver 精简版）：忽略 v 前缀与构建元数据，预发布段比正式段旧。 */
function coreParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('+')[0]!
    .split('-')[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
}

export function compareVersions(a: string, b: string): number {
  const pa = coreParts(a)
  const pb = coreParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  const preA = a.replace(/^v/i, '').split('+')[0]!.split('-')[1]
  const preB = b.replace(/^v/i, '').split('+')[0]!.split('-')[1]
  if (preA === preB) return 0
  // 1.2.0-beta < 1.2.0
  if (preA && !preB) return -1
  if (!preA && preB) return 1
  return preA! > preB! ? -1 : 1
}
