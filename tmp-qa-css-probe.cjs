// TEMPORARY QA PROBE — deleted after the run.
// Tests EVERY container that hosts a <Cover> for the "img escapes container" regression.
const { app, BrowserWindow } = require('electron')

const CSS = `
body { margin:0; }
.app { position: relative; width: 1200px; height: 800px; background:#eee; }
.page { padding: 40px; }
.albumHero { display:flex; gap:28px; align-items:flex-end; }
.albumCover { width:232px; height:232px; border-radius:10px; overflow:hidden; flex:0 0 auto; }
.albumCover img, .albumCover > div { width:100%; height:100%; }
.avatar { width:48px; height:48px; border-radius:999px; overflow:hidden; flex:0 0 auto; background:#ddd; }
.avatar img, .avatar > div { width:100%; height:100%; }
.modalCover { width:96px; height:96px; border-radius:8px; overflow:hidden; flex:0 0 auto; }
.modalCover img, .modalCover > div { width:100%; height:100%; }
.cardArt { position:relative; width:200px; height:200px; overflow:hidden; }
.cardArt img, .cardArt > div { width:100%; height:100%; }
.thumbWrap { position:relative; width:40px; height:40px; overflow:hidden; }
.thumbWrap img, .thumbWrap > div { width:100%; height:100%; }
.cover { display:block; object-fit:cover; background:#ccc; border-radius:4px; flex:0 0 auto; }
.placeholder { display:flex; align-items:center; justify-content:center; background:linear-gradient(160deg,#aaa,#888); }
.coverImage { position:absolute; inset:0; opacity:0; transition:opacity 220ms; z-index:1; }
.coverReady { opacity:1; }
`

const SVG = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIj48cmVjdCB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgZmlsbD0iI2ZmMDAwMCIvPjwvc3ZnPg=="

const block = (cls) => `
  <div class="${cls}">
    <div class="cover placeholder"></div>
    <img class="cover coverImage coverReady" src="${SVG}" />
  </div>`

const HTML = `<!doctype html><html><head><style>${CSS}</style></head><body>
<div class="app"><div class="page">
  <div class="albumHero">${block('albumCover')}</div>
  ${block('avatar')}
  ${block('modalCover')}
  ${block('cardArt')}
  ${block('thumbWrap')}
</div></div></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  const res = await win.webContents.executeJavaScript(`(() => {
    const out = []
    for (const box of document.querySelectorAll('.albumCover,.avatar,.modalCover,.cardArt,.thumbWrap')) {
      const cls = box.className
      const b = box.getBoundingClientRect()
      const img = box.querySelector('img').getBoundingClientRect()
      const ph = box.querySelector('.placeholder').getBoundingClientRect()
      const same = Math.abs(img.x-ph.x)<1 && Math.abs(img.y-ph.y)<1 &&
                   Math.abs(img.width-ph.width)<1 && Math.abs(img.height-ph.height)<1
      out.push({cls, container:[Math.round(b.width),Math.round(b.height)],
                img:[Math.round(img.width),Math.round(img.height)],
                imgXY:[Math.round(img.x),Math.round(img.y)],
                phXY:[Math.round(ph.x),Math.round(ph.y)], aligned: same})
    }
    return out
  })()`)
  console.log('RESULT ' + JSON.stringify(res, null, 1))
  for (const r of res) {
    console.log(`${r.aligned ? 'OK  ' : 'BAD '} .${r.cls}  container=${r.container}  img=${r.img} at ${r.imgXY} vs ph ${r.phXY}`)
  }
  app.quit()
})
