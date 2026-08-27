# DSH 收敛式上下文压缩插件

> 状态：ACTIVE  
> Goal ID：dsh-compaction-convergence  
> 最近维护：2026-08-27T16:53:00+08:00  
> 权威目标：D:\project\dsh-compaction-convergent\docs\acceptance\compaction-convergence\goal.md

## 总目标

基于 DeepSeek Harness 官方 `dsh-compaction-basic` 实现独立可替换插件 `@zzusp/dsh-compaction-convergent`，保持 Session 事务、工具配对、取消、持久化和溢出恢复契约，只修复自动压缩在摘要不缩小时反复选择过小范围而无法收敛的问题，并形成可复核交付证据。

## 完成条件

- 固定并注明官方源码提交及 MIT 来源，独立包可构建、打包和安装。
- 仅 `SummaryNotSmallerError` 触发 `retainTokens -> floor(retainTokens / 2) -> 0` 的范围扩张；重复范围不重复调用摘要器。
- 官方基线行为、错误分类、工具配对、循环收敛和溢出恢复测试通过。
- `.tgz` 内容及隔离安装解析通过。
- 生产 Session 副本在隔离 `DSH_HOME` 中完成真实压缩并能继续下一条消息；steering 取消边界单独报告。
- 若本地 Web profile 被授权并具备环境，则完成 artifact、health、API、监听、UI 分层验证；否则明确保留为未验证边界。
- 按仓库 Git 规则完成提交、推送及 PR 状态回读。

## 范围与约束

- 官方基线：`deepseek-ai/deepseek-harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。
- 不修改全局安装，不直接测试生产 Session；先使用副本和隔离 `DSH_HOME`。
- 不删除“摘要必须更小”保护，不把 provider、network、abort、surface changed、commit 或 persistence 错误误判为范围问题。
- 保持 `/compact` 无参数契约及 `retainTokens=0` 最大平衡头部语义。
- 非源码产物只进入 `docs/` 既有分类；大 binary 不入库。

## sub goal matrix

| ID | 子目标 | 完成判据 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| SG1 | 建立官方兼容独立包基线 | 源码、来源说明、依赖与官方测试可在独立仓库执行 | 完成 | `round-1.md`：官方基线 122/122 |
| SG2 | 实现类型化失败与自适应范围扩张 | 仅摘要不缩小触发扩张，重复范围熔断，失败明确终止 | 完成 | `src/index.ts`、`src/region.ts`；跨 turn generation 缓存已覆盖 |
| SG3 | 完成单元与循环集成验证 | 交接列出的范围、错误分类和循环用例全绿 | 完成 | `matrix.csv`、`round-1.md`：126/126 |
| SG4 | 构建、打包和隔离安装 | build、pack 内容、隔离 consumer 解析均通过 | 完成 | `round-1.md`：17-file pack 与隔离 import |
| SG5 | 真实 Session 副本验收 | 新 replacement 生成、token 下降、可继续消息，取消边界独立记录 | 进行中 | 重复调用已熔断；最大平衡范围仍为 843 tokens，尚无 replacement |
| SG6 | 本地 Web 与原 Resident 分层恢复 | 按授权范围分别验证 artifact/health/API/listener/UI/真实消息 | 进行中 | Resident artifact/provider 已替换；服务与消息未启动 |
| SG7 | Git/PR 收口 | 本地实跑、提交、推送、PR URL/state 回读完整 | 完成 | 公共仓库与 PR #1 已创建并回读 |

## 当前检查点

- 当前子目标：SG6
- 唯一下一步：在明确控制外部消息副作用的条件下启动 Resident/Web，分别验证 listener、health/API/UI，再决定是否恢复原 Session。
- 未闭环项：真实副本因工具配对边界无法产生新 replacement；Resident/Web 尚未启动；真实消息未验证。

## 进展

- 2026-08-27：读取交接材料与本机项目约束；确认工作区仅有交接文件且不是 Git 仓库；拉取官方 master 并固定提交 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`；代码搜索确认普通错误与固定保留预算循环仍存在。
- 2026-08-27：独立基线 122/122；实现类型化错误、三档扩张、单检查去重与跨 turn generation 缓存；当前 126/126，build/pack/隔离安装通过。真实 Session 副本证明三档预算均为同一 843-token range，两次压力检查只调用一次摘要器，但没有 replacement。
- 2026-08-27：建立 `zzusp/dsh-compaction-convergent` 公共仓库与 PR #1；commit 标识包安装到 Resident profile，实际 import、关键文件和 dump-config 证明新 provider 已替换官方 provider。服务仍停止，运行态与消息未验证。

## 重大决策

- 以官方完整 `compaction-basic` 包为基线重命名，不 monkey patch、不重写事务层；原因是官方只开放 summarizer 子类钩子，范围选择和事务语义必须整体兼容。
- 第一版将扩张预算固定为 `[1, 0.5, 0]`，暂不公开新配置；减少配置面并直接覆盖已确认故障。
- 失败范围缓存以 `Session` 弱引用保存，并用 `surface.replaceGeneration` 自动换代；既不跨 Session 泄漏，也不会在表层已前进后错误熔断新尝试。

## 重要信息

- 现场版本为 DSH `0.1.1-rc.2`；原 Web/Resident 已停止，端口 `3080`、`18998` 无监听是交接时点事实，需实时回查。
- 故障 Session 文件：`C:\Users\64554\.dsh\sessions\--D-baibu-agent--\session-group-00fb7328cc47085feddbf03e-87f62c1b\session.jsonl`，只能复制后隔离测试。
