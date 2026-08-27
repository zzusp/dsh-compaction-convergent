# 收敛式压缩实现方案

## 需求快照

独立发布 `@zzusp/dsh-compaction-convergent`，替换官方 `@deepseek-ai/dsh-compaction-basic`。保持官方事件事务、表层范围、工具调用配对、锁、取消、flush、持久化、手动压缩和 overflow 恢复语义，仅修复自动压力压缩遇到“不缩小摘要”后永久重选同一小范围的问题。

## 当前根因

官方 `BasicCompactionEngine.compactToThreshold()` 每次成功压缩后才使用 `compactionRetries`；单次 `compactRegion()` 内若 framed summary token 数不小于 shadowed token 数，`summarizeCompaction()` 直接抛普通 `Error`。自动 step listener 只记录警告，下一 step 再用同一 `retainTokens` 选择同一范围，形成非收敛循环。

## 实现

1. 在 region 层新增可精确 `instanceof` 判断的 `SummaryNotSmallerError`，携带 `summaryTokens` 与 `shadowedTokens`；保留原消息中的 token 诊断。
2. 压力压缩中，把一次“成功 replacement 尝试”内部展开为三个保留预算：原值、向下取整的一半、零。每个预算都重新测量表层并重新选择范围。
3. 本次压力检查维护 `start:end` 集合。范围重复时跳过模型调用，继续更激进预算。
4. 只有捕获 `SummaryNotSmallerError` 才继续预算扩张；其它错误原样抛出。
5. 三档预算耗尽后抛出 `compaction cannot find a shrinking balanced range`，并保留最后一次类型化错误为 `cause`。
6. 每次成功 replacement 后继续沿用官方 `compactionRetries` 计数与重新计量逻辑；范围扩张次数不占用成功重试次数。
7. overflow 与 `/compact` 继续走官方单次 `retainTokens=0` 路径，不套用压力扩张循环。

## 验证

- 先跑官方搬运测试，确认独立包基线。
- 新增类型化错误、扩大 `end`、重复范围一次调用、零预算终止、非范围错误透传测试。
- 新增旧 checkpoint + 后续历史循环复现，断言 replacement generation 前进和下一 step 可继续。
- 运行 typecheck、测试、build、pack 内容审计、隔离 consumer 安装。
- 最后复制真实 Session 到隔离 `DSH_HOME` 验收；生产 profile 切换和真实消息恢复作为独立后续门禁。
