# 连续压缩作业与摘要容量学习

## 问题

自动 pressure 压缩把 `compactionRetries + 1` 当成单次触发允许提交的成功 replacement 数。超大 Surface 即使每块都成功缩小，也可能在固定次数耗尽后仍高于阈值；下一代 Surface 又会丢失 provider 超窗探测结果，从头提交相同的大范围。结果是压缩已经产生持久进展，却仍把未收敛请求交回主模型，并重复付出高延迟超窗调用。

## 目标

- 一次 pressure 或 context-overflow 触发形成一个稳定 `jobId` 的逻辑作业；成功分块不消耗固定重试槽位，作业持续到 Surface 低于目标阈值。
- 每个分块仍使用既有 `compaction/start -> summary -> replacement -> end` 原子事务；失败尝试不写 summary 或 replacement。
- 默认摘要器按完整 envelope 生成容量键，记录最大成功 replay、最小失败 replay 与安全余量。Surface generation 变化不清空该容量；provider、model、context window、输出预留、system/tools/指令或计量策略变化时换键。
- 作业与容量诊断随既有 `compaction/*` 事件持久化；新 engine 从事件重建未完成作业、失败范围与容量上下界，不重复已提交分块或已知失败探测。
- 指标明确区分 Surface 总量、摘要请求估算、provider usage、被遮蔽 token 与 replacement token；只有低于阈值才标记 completed。
- 取消、最老不可分单元超窗、摘要不缩小、重复范围、generation/token 无进展及未知错误均有限终止。

## 方案

1. 默认摘要 envelope 增加稳定容量键。键包含摘要 provider/model、context window、`maxTokens`、固定 envelope token、压缩指令、system/tools 内容及 TokenMeter 策略标识；成功结果带回完整 envelope 估算。
2. 在 engine 中维护可由 Session 日志重建的容量 profile。provider 超窗更新最小拒绝 replay；成功摘要更新最大接受 replay。后续分块先按成功上界减去安全余量选择 balanced head prefix，再保留既有预检精确缩小与 provider 折半探测。
3. 自动压缩改为单作业收敛循环：每次重新计量、选择范围、提交一个原子分块并重新计量。只有严格 generation 前进且总 token 下降才继续；`compactionRetries` 不再限制成功分块数。
4. 在既有 `compaction/start`、`compaction/summary`、`compaction/end` payload 中追加可忽略的 `convergence` 诊断对象，避免引入未注册的新 Session 事件类型。summary 记录可计算的 after 值和 `willContinueJob`；失败 end 记录范围、失败分类及容量观测。
5. 重启时按事件顺序折叠 `convergence`：恢复最后一个仍需继续的 job、下一个 chunk/attempt、同 job 的失败范围和所有兼容容量 profile。旧日志没有该字段时保持原行为。

## 边界

- 不扩大模型上下文窗口，不改变 Session Surface 替换协议，不丢弃原始日志事件。
- 不引入滚动 Session Memory、prompt-cache 管理或文件/技能重注入。
- 自定义 `summarize()` 没有默认 envelope 估算时仍可连续收敛，但不会使用默认摘要器的容量 profile。

## 验证

- 确定性构造超过阈值四倍、且每次只能接受有限 replay 的 Surface；一次调用完成到阈值以下，成功分块数超过旧上限。
- 首次 provider overflow 后验证后续 generation 和重新构造的 engine 直接使用安全容量，不再提交同级大探测。
- 改变 system/tools、摘要 route、context window 或 `maxTokens` 后验证容量键变化，不复用旧上界。
- 验证持久 jobId、chunk/attempt 单调、success/failed 事务原子性、取消/超大 unit/不缩小/无进展的有限失败。
- 运行 typecheck、全量测试、coverage、build 与 pack dry-run。
