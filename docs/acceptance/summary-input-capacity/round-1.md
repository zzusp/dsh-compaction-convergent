# Round 1：摘要输入容量收敛

## 结论

Issue #4 的确定性回归与既有压缩回归全部通过。默认摘要器会在模型调用前计量完整 envelope；若目标范围超出摘要模型容量，则选择容量内最大的 balanced prefix。Provider 仍返回 `CONTEXT_WINDOW_EXCEEDED` 时，自动路径只尝试更小且未提交过的范围；同一 surface generation 内不会重复付费。最老不可分单元仍超窗时，会有限失败并返回 seq/token/envelope 诊断，且不写 summary 或 replacement。

## 用例证据

- 完整 envelope：相同 surface 在 `contextWindow=1800` 下加入大 system/tools 后，实际 replacement 范围小于无 envelope 情况；已发送请求满足 `estimated input + maxTokens <= 1800`，再加入下一节点即超预算，证明选择的是最大可提交前缀。
- 多轮压力：大 system/tools + 大 surface 的 pressure 场景从阈值以上完成容量分块，最终 `ctx.tokenMeter.measure(session).totalTokens < 1440`。
- Provider 反馈：确定性 adapter 对过大摘要返回 `CONTEXT_WINDOW_EXCEEDED`；观测到 replay message 数严格下降且无重复，最终只写一条 `compaction/summary`。
- 跨调用熔断：provider 拒绝到最老 unit 后，同 generation 第二次调用没有新增模型请求；手工推进 `surface.replaceGeneration` 后重新允许尝试。
- 终止诊断：单个超大 unit 在预检阶段得到 `SUMMARY_SURFACE_UNIT_TOO_LARGE`，包含 unit start/end/token、context window、fixed envelope、instruction 与 output reserve；模型调用数为 0，surface generation 不变。
- 真实 loop：原始 conversation 请求先超窗、摘要请求再超窗时，压缩器缩小摘要范围并成功落 checkpoint，agent loop 随后重建原始请求并完成 turn。
- 事务：所有失败摘要尝试都有配对的 `compaction/start` / `compaction/end`；失败尝试没有 `compaction/summary` 或 replacement。

## 命令证据

- `npm run typecheck`：PASS。
- `npm test`：5 files，136 tests，全部 PASS。
- `npm run test:coverage`：PASS；statements 90.86%，branches 90.05%，functions 93.39%，lines 92.10%。
- `npm run build`：PASS。
- `npm pack --dry-run`：PASS；20 files，package size 44.4 kB，unpacked size 157.3 kB。

## 未覆盖边界

- 本轮没有拿 Issue 中的匿名化 101 MB Session，也没有调用真实生产摘要 provider；因此未声称该现场 Session 已恢复。
- 真实 provider tokenizer 仍可能比固定启发式估算更严格；该偏差由 provider 侧规范超窗反馈触发的严格缩小与同 generation 去重闭环。
