# 已闭合步骤孤儿调用压缩

## 症状

问题 Session 的当前 surface 有 880 个节点、120,665 surface tokens，但所有常规保留预算都只能选择一个 843-token checkpoint。工具配对计数为 60 calls / 58 results，最后一个平衡边界停在首节点。

## 根因

`seq 338` 的一个已结束步骤写入了两个 `group_task_create` 调用，但从未写入对应 result。官方边界 helper 只累计 surface 上的 call/result 数量，因此这两个欠账永久跨越其后所有切分点。降低 `retainTokens` 不能改变该状态。

## 修复

1. 保留普通范围、overflow 和手动压缩的既有配对规则。
2. 只有普通范围已因 `SummaryNotSmallerError` 失败时才检查最大范围。
3. 最大范围仅接受两类尾部：正常配对平衡；或全部未回答调用都属于已有持久化 `step/end` 的旧步骤。
4. 对后一类，仅在摘要请求输入中紧邻调用插入 synthetic error tool result；不修改原 Session 事件，不允许当前开放步骤的调用进入。
5. 整个 surface 在异步摘要期间必须保持不变；任何追加都会使事务失败而不 replacement。

## 验证目标

- 正常工具配对、overflow 尾部保留和重复范围熔断回归不变。
- 闭合步骤孤儿调用可以进入最大范围，摘要输入配对完整，原日志不新增 tool result。
- 问题 Session 新副本产生 replacement、token 下降、持久化后可重载并可追加下一条消息。

## 恢复前一次性 repair

Web 恢复历史 Session 会先追加 `session/end-seed`，因此在线 provider 不能承担病理历史的首次修复。包额外导出 `@zzusp/dsh-compaction-convergent/repair`，只用于 Resident 禁用时的一次性启动：

1. 输入、输出与报告路径必须不同，输出必须与输入同目录且尚不存在。
2. 调用前同时校验输入 SHA-256 与 Session ID；输入始终只读。
3. 显式选择最大历史 surface，不依赖自动 pressure 阈值。
4. 单次请求若超过模型窗口，将消息按工具配对平衡边界切成约 180,000 字符的时间顺序分块，先生成真实模型局部摘要，再递归合并为一个标准八段 checkpoint。
5. 最终仍通过官方兼容的 `compaction/start → summary → replace → compaction/end` 事务提交；摘要不缩小或 surface 改变仍会失败。
6. 仅在 replacement、token 下降和持久化重载都成功后，才原子创建输出与不含摘要正文的报告。
