module.exports = require("./entry.node").entry({ exports, require, module, __filename, __dirname });

/* ==== AMLL overlay auto-inject (appended, never wraps the host entry) ====
 * 只做一件事：把 resources/amll/soda-amll.js 注入每个 renderer 窗口。
 * 不改写宿主的 entry 逻辑，避免与新版运行时的模块解析冲突。
 * 插件的 preload 扇出（transportPort 多订阅）由 sodamusic-preloads/main.js 负责。
 */
(function __amllAutoInject() {
  const fs = require('fs');
  const path = require('path');
  const electron = require('electron');

  const candidates = [
    path.join(process.resourcesPath, 'amll', 'soda-amll.js'),
    path.join(__dirname, 'amll', 'soda-amll.js'),
    path.join(__dirname, '..', 'amll', 'soda-amll.js'),
    path.join(__dirname, '..', '..', 'amll', 'soda-amll.js')
  ];
  let src = null;
  let hit = '';
  for (let i = 0; i < candidates.length; i++) {
    try {
      const text = fs.readFileSync(candidates[i], 'utf8');
      if (text) {
        src = text;
        hit = candidates[i];
        break;
      }
    } catch (e) {}
  }
  console.log('[amll] overlay ' + (src ? 'loaded from ' + hit : 'missing; resourcesPath=' + process.resourcesPath));

  if (!src) return;

  const inject = (wc) => {
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript('!!window.__SODA_AMLL__', true)
      .then((already) => (already ? null : wc.executeJavaScript(src, true)))
      .then(() => console.log('[amll] inject ok'))
      .catch((e) => console.log('[amll] inject failed: ' + String((e && e.message) || e)));
  };

  const injectSoon = (wc) => {
    setTimeout(() => inject(wc), 1500);
  };

  electron.app.on('browser-window-created', (_e, win) => {
    try {
      win.webContents.on('did-finish-load', () => injectSoon(win.webContents));
    } catch (e) {}
  });

  electron.app.on('ready', () => {
    setTimeout(() => {
      try {
        const wins = electron.BrowserWindow.getAllWindows();
        for (const w of wins) injectSoon(w.webContents);
      } catch (e) {}
    }, 2500);
  });
})();
