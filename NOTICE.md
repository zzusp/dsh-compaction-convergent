# 上游来源说明

本项目基于 MIT 许可的 DeepSeek Harness 官方包
`@deepseek-ai/dsh-compaction-basic` 修改而来。

- 上游仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 固定提交：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- 上游目录：`packages/compaction/compaction-basic`
- 上游许可：MIT，完整许可见 `LICENSE`

本分支只增加摘要不缩小时的收敛式范围扩张与重复范围熔断，并将包重命名为
`@zzusp/dsh-compaction-convergent`。官方事务、事件和持久化实现保留为兼容基线。

## Alpha.2 compatibility update

Adapted system-message preservation, tool-role replay, output reservations, and summary-error recovery from upstream tag `dsh-v0.2.1-alpha.2`, commit `d743267388641bc76f17c45ce8b4c231aed1d32c` (MIT). The original derivation remains identified above. The convergent job, capacity-learning, retention, and bounded-failure policy remains package-owned.
