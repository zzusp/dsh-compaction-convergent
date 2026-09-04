# Round 1：连续压缩作业

## 结论

Issue #7 的确定性用例和既有回归全部通过。一次 pressure 触发可在 `compactionRetries: 0` 下完成超过 4 个成功分块，并只在完整请求低于阈值后标记 completed。provider 超窗后的成功/拒绝容量、jobId 与 chunk/attempt 会随既有 `compaction/*` 事件持久化；重建 Session 与 engine 后可沿用同一 job 和安全容量，避免重复首个大探测。

## 用例证据

- 超大 Surface：测试输入初始完整请求大于 `4 × 800` tokens；单次 `compactIfNeeded(..., 'pressure')` 完成超过 4 个成功 replacement，最终 `< 800`。
- 作业单调性：同一触发的所有诊断只有一个 jobId；成功记录的 chunkIndex 从 0 连续递增，所有 start 的 attemptIndex 从 0 连续递增，每块 `requestTokensAfter < requestTokensBefore`。
- 容量学习：首轮 provider 拒绝 replay message 数超过 4 的摘要请求；首个成功后，后续 generation 的请求均不超过 4 条 replay message。最终 profile 同时包含最大成功、最小失败、样本数、时间戳和安全余量。
- 重启恢复：首个成功块提交后用取消模拟进程中断；从完整事件日志构造新 Session 和 engine，后续记录沿用原 jobId、chunkIndex 连续，首次请求小于原大探测并最终低于阈值。
- 指纹失效：system/tools、`maxTokens`、context window 或摘要 provider/model 任一变化，capacityKey 均变化。
- provider gap：`maximum context length is 200,000` / `messages resulted in 244,000` 的规范错误将 replay ceiling 从 180,000 收紧为 136,000，而非盲目折半。
- 事务与持久化：每个 attempt 都是 `start -> end(error)` 或 `start -> summary -> replacement -> end`；有 SessionStore 时，每个闭合自动分块均调用一次 flush。
- 有限终止：既有 oversized unit、non-shrinking、取消、重复范围回归保持通过；新增“返回成功但 generation 未前进”用例在一次调用后报错终止。
- 指标口径：成功记录分别包含 `requestTokensBefore/After`、`surfaceTokensBefore/After`、`shadowedTokens`、`framedSummaryTokens`、摘要 envelope 估算、输出预留、provider input/output usage 和 `remainingToThreshold`；未知容量的 overflow 仅标记 `one-shot`，不误标 completed。

## 命令证据

- `npm run typecheck`：PASS。
- `npm test`：5 files，143 tests，全部 PASS。
- `npm run test:coverage`：PASS；statements 90.88%，branches 89.03%，functions 94.48%，lines 92.18%。
- `npm run build`：PASS。
- `npm pack --dry-run`：PASS；22 files，package size 52.1 kB，unpacked size 187.9 kB；包含 `lib/convergence.js` 与 `lib/convergence.d.ts`。

## 反证与未覆盖边界

- 已验证旧 `compactionRetries: 0` 不再截断成功分块；该字段仍可解析仅为配置兼容，但不再是自动 job 的成功块上限。
- 未使用 Issue 中约 922k tokens 的真实匿名 Session，也未调用生产摘要 provider，因此不声称现场 Session 已恢复或真实 provider 延迟已经下降；本轮证明的是确定性同构场景、事件恢复和全量本地回归。
- 自定义摘要器若不返回 `summaryEnvelope`，仍会连续分块，但不会获得默认摘要器的容量学习；无容量元数据的 overflow 成功记录为 `one-shot`，不声称已低于未知阈值。
