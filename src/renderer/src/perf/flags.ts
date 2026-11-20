/** 性能对照开关：同一个构建里用 ?perfLegacy=1 打开「上一版」路径，用于 A/B 归因。 */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')
export const PERF_LEGACY = params.has('perfLegacy')
/** 只关「页面保活」，保留虚拟化：用来验证保活本身是否值得 */
export const PERF_NO_KEEPALIVE = params.has('perfNoKeepAlive')
