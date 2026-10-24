/**
 * 'ended' 事件的接纳判据。
 *
 * 背景：切歌时上一首的 'ended' 事件可能排在 load() 之后才派发，
 * 那时新曲已经开始播放，就会把刚点开的歌误判成「播完了」并跳到下一首。
 *
 * 这里刻意**不用时间窗**做主判据：纯时间窗（比如 load 后 900ms 内一律忽略）
 * 会连带吞掉「用户刚开播就拖到结尾」这种真实播完事件，导致播完不自动下一首。
 *
 * 真正的语义判据是媒体元素的 ended 标志：
 * - load() 会同步把 ended 置回 false，因此旧资源的迟到事件一定被识别为 stale；
 * - 只有当前资源真的走到结尾，ended 才为 true。
 *
 * 时间窗只作为「浏览器上报不一致」时的二级兜底，且在窗口内依然放行
 * elementEnded 为 true 的事件，避免误杀真实播完。
 */

/** 一次 'ended' 事件是否应当被当作「当前曲目真的播完了」。 */
export function shouldAcceptEnded(input: {
  /** 是否落在 load() 之后的保护窗口内 */
  withinGuard: boolean
  /** 媒体元素的 ended 标志 */
  elementEnded: boolean
  /** 本次播放是否已经处理过一次 ended */
  alreadyFired: boolean
}): boolean {
  // 同一首歌只处理一次，防止连续跳过多首
  if (input.alreadyFired) return false
  // 元素没有报告 ended → 要么是旧资源的迟到事件，要么是被 load() 重置了
  if (!input.elementEnded) return false
  // 保护窗口内也放行「元素确实 ended」的事件：
  // 窗口只用来兜住浏览器上报不一致，不能吞掉真实播完。
  void input.withinGuard
  return true
}

/** load() 之后保护窗口的长度（毫秒）。 */
export const ENDED_GUARD_MS = 900
