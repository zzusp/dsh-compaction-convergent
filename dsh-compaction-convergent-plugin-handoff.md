# DSH 收敛式上下文压缩插件交接说明

## 1. 目标

新建一个独立仓库，实现可替换 `@deepseek-ai/dsh-compaction-basic` 的 DSH/Cordis 上下文压缩插件。插件必须保持官方 Session 事件、摘要检查点、工具调用配对、取消和持久化契约兼容，只修复自动压缩选择过小范围后无法收敛的问题。

建议包名：

```text
@zzusp/dsh-compaction-convergent
```

该能力是通用 Harness 基础设施，不依赖钉钉，不应放入 `dingtalk-dsh-assistant` 仓库。

## 2. 已确认的现场故障

故障 Session：

```text
session-group-00fb7328cc47085feddbf03e-87f62c1b
```

本机事件文件：

```text
C:\Users\64554\.dsh\sessions\--D-baibu-agent--\session-group-00fb7328cc47085feddbf03e-87f62c1b\session.jsonl
```

已确认事实：

1. 自动压缩确实启用并触发，并非 `auto` 配置失效。
2. `turn 338` 曾成功生成一次 `compaction/summary`。
3. 后续自动压缩反复只选择约 `843 tokens` 的旧 checkpoint。
4. 新摘要加固定框架后为约 `843–856 tokens`，触发：

   ```text
   summary is not smaller than the shadowed content
   ```

5. 替换被正确拒绝，但下一轮仍选择相同范围，形成不收敛循环。
6. 最近一次压缩还被连续消息 steering 打断，事件为：

   ```text
   Request was aborted
   ```

7. DSH Web/Resident 已停止；PID `32736` 已结束，`3080` 与 `18998` 均已确认无监听。不要把“停止”误报为 Session 已修复。

## 3. 当前官方版本与默认策略

现场版本：

```text
@deepseek-ai/dsh 0.1.1-rc.2
@deepseek-ai/dsh-compaction-basic 0.1.1-rc.2
```

npm 在 2026-08-27 查询到的 `latest` 和 `next` 均为 `0.1.1-rc.2`，没有可直接升级的新版本。

默认策略：

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `auto` | `true` | 在 step 边界检查压力，并处理规范化上下文溢出 |
| `thresholdRatio` | `0.8` | 达到模型上下文窗口 80% 时触发 |
| `retainRatio` | `0.16` | 最近 16% 上下文原样保留 |
| `maxTokens` | `8192` | 摘要请求最大输出 token |
| `compactionRetries` | `1` | 成功替换后仍超阈值时额外尝试一次 |
| `maxOverflowRetries` | `1` | 规范上下文溢出后的最大恢复重试次数 |

注意：当前 `compactionRetries` 只覆盖“压缩成功但总体仍超阈值”，不覆盖“摘要不比被替换内容小”。后者会直接抛出，下一 turn 再从原策略重来。

## 4. 官方实现中的关键边界

官方仓库：

```text
https://github.com/deepseek-ai/deepseek-harness
```

主要源码：

```text
packages/compaction/compaction-basic/src/region.ts
packages/compaction/compaction-basic/src/index.ts
packages/compaction/compaction-basic/src/config.ts
packages/compaction/compaction-basic/src/summarizer.ts
```

发布包只包含编译产物；不要直接修改全局安装位置：

```text
D:\soft\node-v16.20.2\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js
```

否则升级会覆盖、缺少完整测试环境，而且会无审查地影响所有 profile。

必须复用或保持兼容的官方能力：

- `CompactionEngine` / `ctx.compaction` 服务契约。
- `toolPairingBalancedBefore()` 与 `toolPairingBalancedAfter()`。
- `compaction/start` → `compaction/summary` → replace checkpoint → `compaction/end` 事务顺序。
- `compactCheckpointSource(compactionId)` 生成的来源身份。
- `surfaceOp: { op: 'replace', start, end }` 的位置范围语义。
- 活跃压缩锁、崩溃遗留标记、取消、flush 与持久化语义。
- `/compact` 通过 `ctx.compaction.compactNow()` 工作，且当前命令不接受参数。

官方只将 `summarize()` 设计为受支持的子类钩子，没有开放范围选择器。因此最稳妥的实现是基于官方 `dsh-compaction-basic` 源码建立重命名分支包，而不是在业务插件里 monkey patch，亦不是从零重写事务层。

## 5. 根因

现有范围选择算法从尾部累计 token，达到 `retainTokens` 后，把此前头部选为压缩范围，并将切点向前调整到工具调用/结果平衡边界。

当前故障链：

```text
达到 80% 压力阈值
→ retainRatio=16% 划定近期保留区
→ 可压缩头部退化为约 843-token 的旧 checkpoint
→ 摘要正文加固定章节与 <compacted-summary> 框架后约 843–856 tokens
→ “摘要不得大于等于原内容”保护拒绝替换
→ 下一 turn 使用相同 retainTokens，重新选择相同范围
→ 永久不收敛
```

“摘要不得更大”的判断是正确保护，不应删除。要修复的是失败后的范围扩张与重复范围熔断。

## 6. 推荐实现

### 6.1 类型化非收敛错误

不要解析错误字符串。新增内部错误类型：

```ts
export class SummaryNotSmallerError extends Error {
  constructor(
    readonly summaryTokens: number,
    readonly shadowedTokens: number,
  ) {
    super(
      `summary is not smaller than the shadowed content `
      + `(${summaryTokens} estimated framed tokens >= ${shadowedTokens})`,
    )
  }
}
```

在 `summarizeCompaction()` 中用该类型替换普通 `Error`。网络、提供方、取消、表层变化、commit 和 persistence 错误必须继续原样抛出，不能被当成范围问题重试。

### 6.2 自适应扩大压缩范围

一次压力检查内按以下保留预算尝试：

```text
原 retainTokens → floor(retainTokens / 2) → 0
```

其中 `0` 表示选择最大安全头部范围，但仍保留最新不可分单元，并保持工具调用/结果平衡。

只有捕获 `SummaryNotSmallerError` 时才进入下一个更激进预算。每次预算变化都必须重新测量 Session 表层并重新选择范围。

### 6.3 重复范围熔断

记录本次压力检查已经尝试的：

```text
start:end
```

如果不同保留预算因不可分单元或配对边界仍得到相同范围，不得再次调用摘要模型。跳过该范围并继续下一个预算。

如果最终 `retainTokens=0` 仍无法得到更大且可缩小的范围，返回明确诊断，例如：

```text
compaction cannot find a shrinking balanced range
```

同一压力状态下不应每个 turn 无限支付相同摘要调用。可以进一步按 `session + surface.replaceGeneration + range` 缓存失败；仅当表层 generation 或选区变化后允许再次尝试。

### 6.4 成功后的现有重试语义

成功替换后重新计量：

- 低于阈值：返回成功结果。
- 仍高于阈值：允许按 `compactionRetries` 继续压缩新的头部。
- 不得把“范围扩张尝试次数”与“成功替换后的继续压缩次数”混为一个计数器。

### 6.5 上下文溢出

官方 `context-overflow` 路径本来使用 `retainTokens=0` 选择最大平衡头部，应保留该语义。该路径仍可能遇到单个不可分节点或摘要请求本身超窗口；插件必须保留原提供方错误，只有 `surface.replaceGeneration` 实际前进后才允许重试模型请求。

### 6.6 `/compact`

当前无参数 `/compact` 内部已经按 `retainTokens=0` 选择最大安全头部，不需要增加自然语言描述，也不需要新增 `--aggressive` 才能获得最大范围。

当前命令契约明确为：

```text
/compact <anything> → Usage: /compact (no arguments)
```

若未来扩展命令，必须使用结构化参数并独立设计兼容性；不要让自然语言直接决定事件范围。

## 7. 建议配置

保持官方参数兼容，并可增加以下插件私有配置：

```yaml
- id: compaction-convergent
  name: '@zzusp/dsh-compaction-convergent'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    expansionRatios: [1, 0.5, 0]
    failedRangeCache: true
    compactionRetries: 1
    maxOverflowRetries: 1
    maxTokens: 8192
```

`expansionRatios` 表示对已解析绝对保留预算的倍率，不是上下文窗口比例。配置必须校验递减、最后为 `0`、不得重复。

若希望第一版最小化，可以不公开新配置，先把 `[1, 0.5, 0]` 固定为内部收敛策略；行为稳定后再决定是否暴露。

## 8. DSH 组合与安装

新插件必须替换官方 provider，不能同时注册两个 `ctx.compaction`：

```yaml
- id: compaction-basic
  name: '@zzusp/dsh-compaction-convergent'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
```

保留：

```yaml
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'

- id: tool-result-pruner
  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
```

建议新仓库产出 `.tgz`，Web profile 使用 commit 后缀包名安装。不要从工作源码目录直接判断部署成功；安装后应核对 profile 中实际解析的包版本和关键文件。

## 9. 必须覆盖的测试

### 9.1 范围选择单元测试

1. 未达到阈值：不压缩。
2. 正常范围摘要成功：保持官方行为。
3. 初始范围摘要不缩小：降低保留预算并扩大 `end`。
4. 预算变化但配对边界导致范围相同：同一范围只调用一次摘要器。
5. 扩至 `retainTokens=0` 仍不缩小：明确失败，不无限循环。
6. 工具调用/结果跨切点：向安全边界调整。
7. 最新工具调用尚未闭合：不切断、不伪造结果。
8. 单个不可分 user/assistant 节点超过预算：报告无法压缩。

### 9.2 错误分类测试

1. `SummaryNotSmallerError` 才触发范围扩张。
2. Provider/network error 原样抛出。
3. Abort 原因原样保留。
4. Surface changed 不按摘要过大重试。
5. Commit/persistence 错误不重试不同范围。

### 9.3 循环集成测试

1. 旧 checkpoint + 大量后续历史：不得只反复压缩 checkpoint。
2. 一次扩张后产生有效 replacement，`surface.replaceGeneration` 前进。
3. 替换后低于阈值，下一 step 正常请求模型。
4. 替换后仍超阈值，按成功压缩重试预算继续收敛。
5. `context-overflow` 仅在持久表层发生进展后返回 retry。

### 9.4 真实 Session 副本验收

严禁直接拿生产 Session 做第一轮测试。复制目标 JSONL 与附件到隔离 `DSH_HOME`，使用相同模型 route 和 profile：

1. 启动前记录原副本的表层 token、节点数和 replace generation。
2. 触发一次普通 pressure compaction。
3. 断言不再连续选择 `843-token` checkpoint。
4. 断言生成新的 `compaction/summary` 和 replacement。
5. 断言替换后 token 明显下降且 Session 可继续执行下一条消息。
6. 单独模拟新消息在压缩期间到达，核对 FIFO/取消边界；不要把“插件压缩修复”与“上层 steering 取消策略修复”混成一个通过结论。

## 10. 验收证据边界

应分别报告：

- 单元测试通过。
- compaction loop 集成测试通过。
- `.tgz` 内容检查通过。
- 隔离 profile 安装并解析到新包。
- Session 副本真实压缩通过。
- 本地 `/health` 与 API/UI smoke 通过。
- 原 DSH Web profile 是否已切换。
- 原 Resident Session 是否已恢复。
- DingTalk 消息是否完成真实收发与回读。

这些是不同证据，不能互相替代。

## 11. 官方相关记录

- 官方设计与实现：<https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/compaction/compaction-basic>
- Discussion #4420：<https://github.com/deepseek-ai/deepseek-harness/discussions/4420>
  - 报告过 `summary is not smaller than the shadowed content` 和大量重复压缩。
- Discussion #3465：<https://github.com/deepseek-ai/deepseek-harness/discussions/3465>
  - 报告自动压缩不完成、推理预算和摘要输入过大等相邻问题。

截至 2026-08-27，官方 master 的 `selectCompactableRange()` 仍按固定保留预算选择头部，`summarizeCompaction()` 仍在摘要不缩小时直接抛错，未看到失败后扩大范围或重复范围熔断的上游实现。

## 12. 新仓库建议交付顺序

1. 拉取并固定官方源码 commit。
2. 复制 `compaction-basic` package 到新仓库，保留 MIT LICENSE 和来源说明。
3. 重命名 package、repository 与 Cordis plugin identity。
4. 先搬运官方测试，确认未修改基线全绿。
5. 添加本说明中的失败测试，先看到红灯。
6. 实现类型化错误、范围扩张和重复范围熔断。
7. 跑单元、集成、构建和 pack 检查。
8. 用隔离 `DSH_HOME` 和真实 Session 副本验证。
9. 打包安装到本地 Web profile，独立核验 artifact、health、API、监听和 UI。
10. 最后才恢复原群 Resident Session，并观察一次真实消息处理。

