/* ==== PINNET BRIDGE (v2) ====
 * 汽水音乐插件 ↔ Pinnet 的联动桥。双模式：
 *
 * 【3.7.0 模式】读 AMLL 组件全局 window.__SODA_AMLL__（state / __lines / 播放时钟）。
 * 【3.8.0 模式】汽水 3.8.0 把 AMLL 重构掉了（renderer bundle 化，services 跑在
 *   rendererMain 的 service bus 上），这里改走官方 RPC：
 *     window.transportPort（preload 暴露的 MessagePort 封装）
 *     → method.invoke {toServiceId:'sharedState'|'player'|'queue', ...}
 *   协议（逆向自 desktopLyrics bundle）：
 *     invoke: {type:'method.invoke', fromWorkerId, toServiceId, methodName, requestId, arguments, callbacks}
 *     return: {type:'method.return', requestId, return:{type:'success',result}|{type:'error',error}}
 *   注入位置在页面 module bundle 之前，用包装 receiveTransport 的方式与页面共享消息流
 *   （port1.onmessage 是赋值式，谁后赋值谁生效；包装后页面与插件互不覆盖）。
 *
 * 数据轮询 sharedState.get('player'|'queue')；控制走
 *   player.togglePlay/seekSeconds/increaseVolume/decreaseVolume + queue.playNext/playPrevious。
 *
 * 歌词界面开着或关着，这里的行为完全一样（不触碰任何 overlay DOM 或 rAF）。
 */
;(() => {
  if (window.__PINNET_BRIDGE__) return
  window.__PINNET_BRIDGE__ = true
  const VERSION = '2.1.0'
  const A = () => window.__SODA_AMLL__
  const HAS_TRANSPORT = typeof window.transportPort === 'object' && window.transportPort !== null
  const MODE_38 = !A() && HAS_TRANSPORT
  let ws = null
  let retry = 0
  let retryTimer = 0
  let hbTimer = 0
  let lastKey = ''

  const token = () => localStorage.getItem('pinnet-token') || 'pinnet'
  const port = () => Number(localStorage.getItem('pinnet-port') || 17891)

  /* Pinnet 是 file:// / localhost，直接加载汽水 CDN 的封面会被防盗链挡掉，
     所以在汽水这边 fetch 成 data URL 再推过去（带正确 Referer / Cookie）。 */
  let coverCache = { src: '', dataUrl: '' }
  let coverPending = ''
  function refreshCover(src) {
    if (!src || src === coverCache.src || src === coverPending) return
    coverPending = src
    fetch(src, { credentials: 'omit' })
      .then((r) => r.blob())
      .then(
        (blob) =>
          new Promise((resolve) => {
            const fr = new FileReader()
            fr.onload = () => resolve(String(fr.result))
            fr.onerror = () => resolve('')
            fr.readAsDataURL(blob)
          })
      )
      .then((dataUrl) => {
        if (dataUrl && coverPending === src) {
          coverCache = { src, dataUrl }
          pushState(true)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (coverPending === src) coverPending = ''
      })
  }

  /* ==================================================================
   * 3.8.0 模式：transportPort RPC
   * ================================================================== */
  let rpcSeq = 1
  const rpcPending = new Map()
  let rpcReady = false
  let pollTimer = 0
  let last38 = { key: '', playing: false, progress: -1, volume: -1, lyricsLen: -1 }
  let current38 = { track: null, lyrics: [], playing: false, positionMs: 0, durationMs: 0, volume: 1, muted: false }

  if (MODE_38) {
    // 与页面共享消息流：先占住 receiveTransport，页面 bundle 之后注册的回调
    // 会经由包装函数与插件并存（而不是互相覆盖 port1.onmessage）。
    const tp = window.transportPort
    const origReceive = tp.receiveTransport.bind(tp)
    tp.receiveTransport = (cb) =>
      origReceive((data) => {
        try {
          dispatch38(data)
        } catch {
          /* ignore */
        }
        try {
          if (cb) cb(data)
        } catch {
          /* ignore */
        }
      })
    function dispatch38(msg) {
      if (!msg || msg.type !== 'method.return') return
      const pending = rpcPending.get(msg.requestId)
      if (!pending) return
      rpcPending.delete(msg.requestId)
      if (msg.return && msg.return.type === 'success') pending.resolve(msg.return.result)
      else pending.reject(new Error((msg.return && msg.return.error) || 'rpc error'))
    }
    function rpc(serviceId, methodName, args = []) {
      return new Promise((resolve, reject) => {
        const requestId = rpcSeq++
        rpcPending.set(requestId, { resolve, reject })
        try {
          window.transportPort.sendTransport({
            type: 'method.invoke',
            fromWorkerId: 'rendererMain',
            toServiceId: serviceId,
            methodName,
            requestId,
            arguments: args,
            callbacks: new Map()
          })
        } catch (e) {
          rpcPending.delete(requestId)
          reject(e)
          return
        }
        setTimeout(() => {
          if (rpcPending.has(requestId)) {
            rpcPending.delete(requestId)
            reject(new Error('rpc timeout: ' + serviceId + '.' + methodName))
          }
        }, 5000)
      })
    }

    /* QRC/行数组 → Pinnet 歌词行（与 3.7.0 的 __lines 同构） */
    function normalizeLyrics(raw) {
      if (!Array.isArray(raw)) return []
      return raw
        .map((l) => {
          if (!l) return null
          // 已是 {startTime, endTime, words:[{startTime,endTime,word}]} 结构
          if (typeof l === 'object' && (l.words || l.wordInfo || l.syllables)) {
            const words = l.words || l.wordInfo || l.syllables || []
            return {
              startTime: l.startTime ?? l.start ?? 0,
              endTime: l.endTime ?? l.end ?? 0,
              text: words.map((w) => (typeof w === 'string' ? w : w.word || w.text || '')).join(''),
              words: words.map((w) => ({
                startTime: (typeof w === 'object' && (w.startTime ?? w.start)) || 0,
                endTime: (typeof w === 'object' && (w.endTime ?? w.end)) || 0,
                word: typeof w === 'string' ? w : w.word || w.text || ''
              }))
            }
          }
          return null
        })
        .filter(Boolean)
    }

    function pickCover(p) {
      let raw = p?.cover_url || p?.coverUrl || p?.picUrl || p?.cover || p?.album?.cover_url || ''
      if (Array.isArray(raw)) raw = raw[0]
      if (raw && typeof raw === 'object') {
        /* 字节系 imageURI：{uri, urls:[前缀], template_prefix} → 拼完整 CDN 地址 */
        if (raw.uri && raw.urls && raw.urls.length) {
          const tpl = raw.template_prefix ? '~' + raw.template_prefix + '.image' : ''
          return raw.urls[0] + raw.uri + tpl
        }
        raw = raw.url || (raw.url_list && raw.url_list[0]) || raw.value || ''
      }
      if (typeof raw !== 'string' || !raw) return ''
      return raw.replace(/\{width\}/g, '800').replace(/\{height\}/g, '800')
    }

    async function poll38() {
      try {
        const player = await rpc('sharedState', 'get', ['player'])
        /* queue 共享状态是 {queue: {...}} 包一层（UI 里 t.value.queue?.playables） */
        const queueWrap = await rpc('sharedState', 'get', ['queue']).catch(() => null)
        const queue = queueWrap && queueWrap.queue ? queueWrap.queue : queueWrap
        if (!rpcReady) {
          rpcReady = true
          send({ type: 'hello', version: VERSION + '-rpc' })
          console.log('[pinnet] 3.8.0 rpc ready, player state keys:', player && Object.keys(player).join(','))
        }
        const key = player?.currentPlayable?.key || (queue && queue.currentPlayable && queue.currentPlayable.key) || ''
        const byKey = queue && queue.playables && queue.playables.byKey ? queue.playables.byKey : {}
        const meta = key ? byKey[key] || player?.currentPlayable || {} : {}
        const playable = meta.playable || meta
        const md = player?.mediaDetail || {}
        const pl = md.playable || playable || {}
        const artists = Array.isArray(pl.artists)
          ? pl.artists.map((x) => (x && (x.name || x)) || '').filter(Boolean).join(' / ')
          : pl.artist || ''
        const durationMs = Math.round(pl.duration || pl.durationMs || 0)
        const progressSec = typeof player.progress === 'number' ? player.progress : 0
        const positionMs = Math.round(progressSec * 1000) || Math.round(player.positionMs || 0)
        const lyrics = normalizeLyrics(pl.lyrics || meta.lyrics || md.lyrics || [])
        const coverUrl = pickCover(pl) || pickCover(meta)
        current38 = {
          track: pl.name
            ? {
                id: String(pl.key || pl.id || key || ''),
                title: pl.name || '',
                artists,
                /* 封面缺位时把字段名带出来，方便诊断结构 */
                album: (pl.album && pl.album.name) || '',
                coverUrl: null,
                durationMs
              }
            : null,
          lyrics,
          playing: !!player.isPlaying,
          positionMs,
          durationMs,
          volume: typeof player.volume === 'number' ? Math.max(0, Math.min(1, player.volume)) : 1,
          muted: !!player.muted,
          pluginVersion: VERSION
        }
        // 3.8.0：直接把 CDN URL 交给 PM 渲染（<img> 外链不受 CORS 限制；
        // renderer 里 fetch 转 dataURL 会被 CORS/防盗链拦掉，实测拿不到）
        current38.track && (current38.track.coverUrl = coverUrl || null)
        push38()
      } catch (e) {
        /* bus 尚未建立时静默重试；持续失败则把错误上屏诊断 */
        const msg = 'RPC ERR ' + ((e && e.message) || e)
        if (!current38.track || current38.track.title !== msg) {
          current38 = {
            ...current38,
            track: { id: 'diag', title: msg, artists: '', album: '', coverUrl: null, durationMs: 0 },
            lyrics: []
          }
          lastKey = ''
          push38()
        }
      }
    }

    function push38() {
      const s = current38
      const key = JSON.stringify([
        s.track && s.track.id,
        s.track && s.track.title,
        s.track && s.track.coverUrl,
        s.lyrics.length,
        s.playing,
        Math.round(s.volume * 100),
        Math.round(s.positionMs / 1000)
      ])
      if (key === lastKey) return
      lastKey = key
      send({ type: 'state', snapshot: s })
    }

    function startPoll() {
      stopPoll()
      pollTimer = setInterval(poll38, 500)
      poll38()
    }
    function stopPoll() {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = 0
    }

    function run38(cmd) {
      try {
        if (cmd.type === 'toggle') rpc('player', 'togglePlay')
        else if (cmd.type === 'next') rpc('queue', 'playNext')
        else if (cmd.type === 'prev') rpc('queue', 'playPrevious')
        else if (cmd.type === 'seek') rpc('player', 'seekSeconds', [cmd.value / 1000])
        else if (cmd.type === 'volume') {
          // 3.8.0 player service 只暴露步进音量；按差值连发步进
          const target = Math.max(0, Math.min(1, cmd.value))
          const cur = current38.volume
          const diff = Math.round((target - cur) * 20) // 5% 步进
          const method = diff > 0 ? 'increaseVolume' : 'decreaseVolume'
          for (let i = 0; i < Math.abs(diff); i++) rpc('player', method).catch(() => {})
        }
      } catch (e) {
        console.log('[pinnet] command failed', cmd, e)
      }
      setTimeout(() => poll38(), 300)
    }
  }

  /* ==================================================================
   * 3.7.0 模式：AMLL 全局（保留原逻辑）
   * ================================================================== */
  function snapshot37() {
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
            coverUrl: coverCache.dataUrl || null,
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
    if (MODE_38) return
    const s = snapshot37()
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
      if (MODE_38) {
        const s = current38
        send({ type: 'heartbeat', heartbeat: { positionMs: s.positionMs, playing: s.playing, at: Date.now() } })
        return
      }
      const s = snapshot37()
      if (s) send({ type: 'heartbeat', heartbeat: { positionMs: s.positionMs, playing: s.playing, at: Date.now() } })
    }, 1500)
  }

  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer)
    hbTimer = 0
  }

  function run(cmd) {
    if (MODE_38) return run38(cmd)
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
      send({ type: 'hello', version: VERSION + (MODE_38 ? '-rpc' : '-amll') })
      if (MODE_38) startPoll()
      else pushState(true)
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
      if (MODE_38) stopPoll()
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

  if (MODE_38) {
    /* 3.8.0：transportPort 由 preload 提供，页面 bundle 尚未执行；
       等 bus 建立（页面 registerTransport 之后）再启动轮询。 */
    setTimeout(() => {
      try {
        connect()
      } catch {
        /* ignore */
      }
    }, 2500)
  } else {
    setInterval(() => {
      refreshCover(A() && A().__coverUrl)
      if (ws && ws.readyState === 1) pushState(false)
    }, 250)
    new MutationObserver(injectButton).observe(document.documentElement, { subtree: true, childList: true })
    connect()
  }

  window.__PINNET__ = {
    snapshot: MODE_38 ? () => current38 : snapshot37,
    connect,
    token,
    port,
    rpc: MODE_38 ? rpc : null
  }
})()
/* ==== /PINNET BRIDGE ==== */
