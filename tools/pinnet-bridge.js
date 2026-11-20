/* ==== PINNET BRIDGE (v1) ====
 * 汽水音乐插件 ↔ Pinnet 的联动桥。
 *
 * 不依赖歌词界面：只读实例上的 state / __lines / 播放时钟，向 Pinnet 的本地
 * WebSocket 推送状态；收到指令时调用插件已有的 hostTransport / seekTo / setVolume。
 * 歌词界面开着或关着，这里的行为完全一样（不触碰任何 overlay DOM 或 rAF）。
 */
;(() => {
  if (window.__PINNET_BRIDGE__) return
  window.__PINNET_BRIDGE__ = true
  const VERSION = '1.3.0'
  const A = () => window.__SODA_AMLL__
  let ws = null
  let retry = 0
  let retryTimer = 0
  let hbTimer = 0
  let lastKey = ''

  const token = () => localStorage.getItem('pinnet-token') || 'pinnet'
  const port = () => Number(localStorage.getItem('pinnet-port') || 17891)

  function snapshot() {
    const a = A()
    if (!a) return null
    const st = a.state || {}
    const md = st.mediaDetail || {}
    const pl = md.playable || {}
    const artists = Array.isArray(pl.artists)
      ? pl.artists.map((x) => (x && (x.name || x)) || '').filter(Boolean).join(' / ')
      : pl.artist || ''
    const base = typeof a.baseMs === 'number' ? a.baseMs : 0
    const live = a.playing ? base + (performance.now() - (a.baseAt || 0)) : base
    return {
      track: pl.name
        ? {
            id: String(pl.key || pl.id || ''),
            title: pl.name || '',
            artists,
            album: (pl.album && pl.album.name) || '',
            coverUrl: a.__coverUrl || null,
            durationMs: Math.round(a.durationMs || 0)
          }
        : null,
      lyrics: Array.isArray(a.__lines) ? a.__lines : [],
      playing: !!a.playing,
      positionMs: Math.round(live),
      durationMs: Math.round(a.durationMs || 0),
      volume: typeof a.volume === 'number' ? a.volume : 1,
      muted: false,
      pluginVersion: VERSION
    }
  }

  function send(obj) {
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj))
    } catch {
      /* ignore */
    }
  }

  function pushState(force) {
    const s = snapshot()
    if (!s) return
    const key = JSON.stringify([
      s.track && s.track.id,
      s.track && s.track.title,
      s.track && s.track.coverUrl,
      s.lyrics.length,
      s.playing,
      Math.round(s.volume * 100)
    ])
    if (!force && key === lastKey) return
    lastKey = key
    send({ type: 'state', snapshot: s })
  }

  function startHeartbeat() {
    stopHeartbeat()
    hbTimer = setInterval(() => {
      const s = snapshot()
      if (s) send({ type: 'heartbeat', heartbeat: { positionMs: s.positionMs, playing: s.playing, at: Date.now() } })
    }, 1500)
  }

  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer)
    hbTimer = 0
  }

  function run(cmd) {
    const a = A()
    if (!a || !cmd) return
    try {
      if (cmd.type === 'toggle') a.hostTransport && a.hostTransport('playpause')
      else if (cmd.type === 'prev') a.hostTransport && a.hostTransport('prev')
      else if (cmd.type === 'next') a.hostTransport && a.hostTransport('next')
      else if (cmd.type === 'seek') a.seekTo && a.seekTo(cmd.value)
      else if (cmd.type === 'volume') a.setVolume && a.setVolume(cmd.value)
    } catch (e) {
      console.log('[pinnet] command failed', cmd, e)
    }
    setTimeout(() => pushState(true), 300)
  }

  function schedule() {
    clearTimeout(retryTimer)
    const delay = Math.min(15000, 1000 * Math.pow(1.6, retry++))
    retryTimer = setTimeout(connect, delay)
  }

  function connect() {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port()}/?token=${encodeURIComponent(token())}`)
    } catch {
      schedule()
      return
    }
    ws.onopen = () => {
      retry = 0
      send({ type: 'hello', version: VERSION })
      pushState(true)
      startHeartbeat()
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'command') run(msg.command)
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      stopHeartbeat()
      schedule()
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  /* 设置菜单里加「在 Pinnet 里播放」——菜单是插件自己重建的，用观察器补按钮 */
  function injectButton() {
    const menu = document.querySelector('.sa-menu.sa-show')
    if (!menu || menu.querySelector('.pinnet-open')) return
    const btn = document.createElement('button')
    btn.className = 'sa-mi pinnet-open'
    btn.textContent = '在 Pinnet 里播放'
    btn.style.cssText =
      'display:flex;align-items:center;gap:8px;width:100%;padding:7px 14px;text-align:left;color:#fff;background:none;border:0;cursor:pointer;font:inherit'
    btn.onmouseenter = () => {
      btn.style.background = 'rgba(255,255,255,.12)'
    }
    btn.onmouseleave = () => {
      btn.style.background = 'none'
    }
    btn.onclick = () => {
      try {
        location.href = 'pinnet://play?token=' + encodeURIComponent(token())
      } catch {
        /* ignore */
      }
      navigator.clipboard && navigator.clipboard.writeText(token())
    }
    menu.appendChild(btn)
  }

  setInterval(() => {
    if (ws && ws.readyState === 1) pushState(false)
  }, 250)
  new MutationObserver(injectButton).observe(document.documentElement, { subtree: true, childList: true })
  connect()

  window.__PINNET__ = { snapshot, connect, token, port }
})()
/* ==== /PINNET BRIDGE ==== */
