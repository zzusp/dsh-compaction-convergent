# 摘要输入容量收敛

## 问题

自动压缩当前只按 surface token 选择范围，摘要调用却还会回放 system、tools，并追加压缩指令和输出预算。范围本身可压缩不代表完整摘要请求能放进摘要模型窗口；一旦 provider 返回 `CONTEXT_WINDOW_EXCEEDED`，当前实现会在后续 pressure / overflow 恢复中重复提交相同范围。

## 目标

- 默认摘要器在调用模型前，按实际摘要 provider/model 的 `contextWindow` 检查完整 envelope：system、tools、选中 messages、压缩指令和 `maxTokens`。
- 最大目标范围超预算时，不调用模型，改选预算内最大的 head-anchored balanced prefix。
- provider 仍返回 `CONTEXT_WINDOW_EXCEEDED` 时，将范围记入当前 surface generation 的失败缓存，再以更小的 balanced prefix 重试；同一 generation 内同一范围最多提交一次。
- 最老的不可分割 balanced unit 仍无法提交时，有限失败并报告 unit seq、估算 token、context window、固定 envelope 与输出预算。
- 失败只写成闭合的 compaction attempt，不写 `compaction/summary` 或 replacement；成功事务、取消、手工压缩和历史 repair 语义保持不变。

## 方案

1. 在摘要器中构造唯一的调用 envelope，并复用 `TokenMeter` 的 message 估算与请求 header 估算，产生容量诊断；已知 capacity 且输入加输出预留超窗时抛出类型化错误，provider 的同类终止错误也包装成同一类型。
2. 在范围模块增加“给定 end 上限和 token 预算，选择最大 balanced prefix”的纯函数，并提供最老不可分割 unit 的诊断信息。
3. 在自动 pressure / overflow 的范围执行层统一处理类型化超窗：缓存失败范围、缩小范围、去重；预检错误按可用 message budget 精确收窄，provider 拒绝则保守折半。
4. 用确定性 adapter 覆盖大 system/tools 预检、provider 超窗后缩小、跨调用去重、不可分割 unit、事务不改写，以及既有回归。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
