# Issue #7 连续压缩作业

## 总目标

大型 Surface 在一次自动触发内按 provider 可接受容量连续分块，最终低于模型压力阈值；容量和作业进度跨 replacement generation、跨 engine 重建可恢复，且所有分块保持既有事务原子性。

## Sub goal matrix

| Sub goal | 状态 | 完成条件 |
| --- | --- | --- |
| SG1 作业循环 | 完成 | 一次触发可完成超过旧 `compactionRetries` 上限的成功分块，最终低于阈值 |
| SG2 容量学习 | 完成 | 成功/拒绝上下界按 envelope key 复用，generation 不清空，key 变化失效 |
| SG3 可恢复诊断 | 完成 | 日志可重建 jobId、chunk/attempt、失败范围与容量 profile |
| SG4 有限终止 | 完成 | 取消、超大单元、不缩小、重复范围、无进展和未知错误均不死循环 |
| SG5 回归与交付 | 进行中 | 全量测试、coverage、build、pack 通过并创建 PR |

## 重大决策

- 复用已注册的 `compaction/*` 事件，在 payload 增加 `convergence` 诊断；不新增下游旧版本无法识别的 Session event type。
- 成功 replacement 次数不再由 `compactionRetries` 截断；循环安全由严格 token/generation 进展和已有类型化终止条件保证。
- 容量只对默认 LLM 摘要 envelope 学习；自定义摘要器没有可验证 envelope 时不猜测兼容键。

## 重要信息

- Issue #7 现场 Surface 约 922k tokens，阈值约 217k；provider 多次拒绝约 244k 的摘要请求，而实际成功分块约 75k–103k。
- 当前基线：`main` 与 `origin/main` 均为 `8b453ab90328d21c82fc839eb3446f7f3f46834e`。

## Sub goal 进展

- Round 1：实现连续作业、容量 profile、持久诊断与逐块 flush；确定性回归和全量验证通过。待完成 Git 提交、push 与 PR 状态回查。
