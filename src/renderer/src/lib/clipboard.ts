/**
 * 剪贴板写入：优先异步 Clipboard API，失败退回插件的 textarea + execCommand 方案。
 * 歌词页里复制歌词/歌曲信息都走这里，任何一步失败都不会抛到界面上。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
