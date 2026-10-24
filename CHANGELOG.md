# Changelog

## 1.1.1 - 2026-10-24

修复（专家复核阶段发现）：
- **播完一首就停住**：自动下一首走 `crossfadeTo`，但它没有重置 `endedFired`，
  导致第一首播完切到第二首后，第二首的 `ended` 被 `alreadyFired` 拦截，链条在第二首断掉。
- **真实播完被误吞**：原「load 后 900ms 内忽略 ended」的时间窗会连带吞掉
  「刚开播就拖到结尾」这类真实播完事件，导致播完不自动下一首。
  改用语义判据（媒体元素的 `ended` 标志，load() 会把它置回 false，
  因此旧资源的迟到事件必然被识别为 stale），时间窗只作二级兜底。
- **暂停恢复后不再换歌**：`play()` 未重置 `endedFired`，若歌曲在暂停态播完，
  恢复播放后再播完不会触发下一首。

新增测试：
- `tests/endedGuard.test.ts`（5 例）—— ended 接纳判据
- `tests/engineAutoAdvance.test.ts`（1 例）—— 连续两首自然播完都能自动推进
- `tests/taskQueue.test.ts` 改用轮询等待，消除高负载下的时序 flake

## 1.1.0 - 2026-10-24

- 对标 AMLL 插件：设置分组对标、底边栏 Q 弹动画、封面与指示器还原、切歌竞态修复、新增 iPod 风格 Cover Flow
