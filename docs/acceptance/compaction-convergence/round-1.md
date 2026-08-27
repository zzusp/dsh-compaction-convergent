# Round 1：源码实现、回归与真实 Session 副本诊断

## 结论

源码收敛策略、官方兼容回归、构建和隔离安装通过。真实 Session 副本证明三档预算当前都被工具配对边界约束为同一 `843-token` checkpoint；跨 turn 缓存将两次压力检查的摘要调用压到一次，但该副本没有产生新 replacement，因此不能把“停止重复付费”报告为“Session 已压缩恢复”。

## PASS 证据

- 官方基线：实现前 4 个官方测试文件共 `122/122` 通过。
- 当前套件：4 个测试文件共 `126/126` 通过，包含真实事务扩张 replacement、重复范围熔断、跨压力检查 generation 缓存和 generation 前进后失效。
- 类型检查：Node `v24.19.0` 下 `npm run typecheck` 通过。
- 覆盖率：语句、函数、行 100%；最后一个防御性分支已标注与官方同风格的不可达理由，待最终重跑确认 branch 100%。
- 构建：`npm run build` 通过。
- pack：dry-run 包含 17 个文件，包括 `LICENSE`、`NOTICE.md`、双语 README、JS 和声明文件。
- 隔离安装：临时 consumer 安装 `.tgz` 后 `npm ls` 解析到 `@zzusp/dsh-compaction-convergent@0.1.1-rc.2-convergent.0`；主入口、`SummaryNotSmallerError` 和 invariant companion 实际导入通过。
- Session 副本：源与副本均为 `16,875,109` bytes，SHA-256 相同。
- Session 当前计量：`41189` events、`862` surface nodes、`replaceGeneration=7`、`totalTokens=128531`；目标为 `openai-codex/gpt-5.6-sol`。
- 三档范围：保留预算 `41344`、`20672`、`0` 均选择 `31636:31636`，范围 token 均为 `843`。
- Session 副本重复检查：两次均明确返回 `compaction cannot find a shrinking balanced range`，`replaceGeneration` 保持 `7`，摘要器总调用次数为 `1`。

## 首次失败及修正

- 独立依赖清单误把 `@deepseek-ai/cordis` 设为 DSH 版本，安装报 peer conflict；修正为官方 peer `4.0.1` 后安装通过，未使用 `--force`。
- 默认终端最初为 Node 22；按用户要求将用户 Path 的 Node 24 排在 Node 22 前，Node 22 目录和 Path 项均保留。
- 隔离导入探针误用 invariant 默认导出；按官方命名导出契约改为 namespace import 后通过，未修改产品导出规避探针错误。

## 未通过边界

- 当前真实 Session 副本没有新 replacement：这是最大安全平衡范围仍只有旧 checkpoint 的真实限制，不是成功压缩证据。
- 尚未安装到 Resident profile，也未启动本地 Web；health、API、listener、UI 均未验证。
- 尚未恢复原 Resident Session，未进行真实钉钉消息收发和回读。
