import { _electron as electron } from 'playwright'
import { join } from 'node:path'
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
env.PINNET_USER_DATA=join(process.env.TEMP,'pinnet-test'); env.PINNET_NO_MIGRATE='1'
const app=await electron.launch({args:[process.cwd()],env,timeout:120000}); const page=await app.firstWindow()
await page.waitForFunction(()=>window.__store&&window.__store.getState().ready,null,{timeout:60000})
await page.evaluate(async()=>{ await window.__store.getState().updateSettings({ theme:'dark', controlBar:'bottom', glass:'full' }) })
await page.waitForTimeout(1200)
console.log('settings controlBar', await page.evaluate(()=>window.__store.getState().settings.controlBar))
// 新底栏：一整条 dock
const dock = await page.evaluate(()=>{
  const el=document.querySelector('[class*="bottomDock"]')
  if(!el) return null
  const r=el.getBoundingClientRect(); const s=getComputedStyle(el)
  // 数内部有没有「胶囊分组」
  const groups=el.querySelectorAll('[class*="group"],[class*="glass"]').length
  return { x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), pos:s.position, radius:s.borderRadius, bg:s.backgroundColor, innerGroups:groups }
})
console.log('dock', dock)
// 侧栏设置按钮：不被遮挡、可点击
const settings = page.locator('[data-nav="settings"]').first()
const box = await settings.boundingBox()
console.log('settings box', box)
if (box) {
  const hit = await page.evaluate(([x,y])=>{const el=document.elementFromPoint(x,y);return el?{tag:el.tagName,cls:el.className,title:el.getAttribute('title'),nav:el.closest('[data-nav]')?.getAttribute('data-nav')}:null},[box.x+box.width/2,box.y+box.height/2])
  console.log('elementFromPoint', hit)
  await settings.click({ force: true })
  await page.waitForTimeout(500)
  console.log('after settings click', await page.evaluate(()=>window.__store.getState().view.kind))
}
// 底栏控件命中检查：播放按钮 / 进度条 / 音量都在 dock 里
await page.evaluate(()=>window.__store.getState().setView({kind:'recent'}))
await page.waitForTimeout(300)
const controls = await page.evaluate(()=>{
  const dock=document.querySelector('[class*="bottomDock"]')
  if(!dock) return null
  const find=(sel)=>dock.querySelector(sel)
  const play=find('[title*="播放"],[title*="暂停"]')
  const pr=document.querySelector('[class*="dockTrack"]')
  const vol=find('[aria-label="音量"]')
  const center=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h?(dock.contains(h)||h===dock?'ok':'BLOCKED by '+h.className):null}
  return { play:center(play), progress:center(pr), volume:center(vol) }
})
console.log('controls', controls)
await page.screenshot({path:'perf/_bottom.png'})
await app.close()
