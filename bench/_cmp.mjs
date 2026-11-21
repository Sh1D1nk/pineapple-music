import { readFileSync } from 'node:fs'
const a=JSON.parse(readFileSync('perf/before-optimize.json','utf8'))
const b=JSON.parse(readFileSync('perf/after-optimize.json','utf8'))
const pct=(list,q)=>{if(!list||!list.length)return 0;const s=[...list].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.round((s.length-1)*q))]}
const paints=x=>x?.hot?.map(h=>h.paint??0)??[]
const cold=x=>x?.cold?.paint??null
const rows=['| 目标 | 改前冷 | 改后冷 | 改前热p50 | 改后热p50 | 改前热p95 | 改后热p95 | p95变化 |','|---|---:|---:|---:|---:|---:|---:|---:|']
for(const y of b.opens??[]){
  const x=(a.opens??[]).find(t=>t.name===y.name)
  if(!x)continue
  const bp=paints(x), ap=paints(y)
  const b95=pct(bp,0.95), a95=pct(ap,0.95)
  const d=b95?((a95-b95)/b95*100):0
  rows.push(`| ${y.name} | ${cold(x)?.toFixed(0)??'—'} | ${cold(y)?.toFixed(0)??'—'} | ${Math.round(pct(bp,0.5))} | ${Math.round(pct(ap,0.5))} | ${Math.round(b95)} | ${Math.round(a95)} | ${d>=0?'+':''}${d.toFixed(0)}% |`)
}
console.log(rows.join('\n'))
const sc=(j,k)=>{const s=j.scroll?.[k];return s?`p50 ${Math.round(pct(s.map(x=>x.gap??x.delta??0),0.5))}`:'—'}
console.log('\nscroll keys',Object.keys(b.scroll??{}))
console.log('scroll sample',JSON.stringify((b.scroll?.songs??[])[0]??b.scroll?.songs??null).slice(0,200))
