# DSH 收敛式上下文压缩插件

> 状态：ACTIVE  
> Goal ID：dsh-compaction-convergence  
> 最近维护：2026-08-27T19:20:00+08:00
> 权威目标：D:\project\dsh-compaction-convergent\docs\acceptance\compaction-convergence\goal.md

## 总目标

基于 DeepSeek Harness 官方 `dsh-compaction-basic` 实现独立可替换插件 `@zzusp/dsh-compaction-convergent`，保持 Session 事务、工具配对、取消、持久化和溢出恢复契约，只修复自动压缩在摘要不缩小时反复选择过小范围而无法收敛的问题，并形成可复核交付证据。

## 完成条件

- 固定并注明官方源码提交及 MIT 来源，独立包可构建、打包和安装。
- 仅 `SummaryNotSmallerError` 触发 `retainTokens -> floor(retainTokens / 2) -> 0` 的范围扩张；重复范围不重复调用摘要器。
- 官方基线行为、错误分类、工具配对、循环收敛和溢出恢复测试通过。
- `.tgz` 内容及隔离安装解析通过。
- 生产 Session 副本在隔离环境中完成真实路径验收；若工具配对边界使范围无法扩大，必须保留反证且不得伪报 replacement、token 下降或 Session 已恢复。
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
| SG5 | 真实 Session 副本验收 | 真实路径完成；成功则证明 replacement/token/续聊，受工具配对阻塞则保留负向证据并证明不重复调用 | 完成（负向边界） | 三档预算均命中同一 843-token 范围；两次压力检查仅一次摘要调用，无新 replacement |
| SG6 | 本地 Web 与原 Resident 分层恢复 | 按授权范围分别验证 artifact/health/API/listener/UI/真实消息 | 进行中 | Resident 已安装 `convergent.2` 且 provider 配置接管；用户要求只安装，服务与消息未启动 |
| SG7 | Git/PR 收口 | 本地实跑、提交、推送、PR URL/state 回读完整 | 完成 | 公共仓库与 PR #1 已创建并回读 |
| SG8 | GitHub 自动构建与版本产物 | PR/main 自动测试构建；合并后 tag 触发 Release 并附带可回读 `.tgz` | 完成 | PR/main/tag 三次 Actions 全绿；Release tgz 哈希与 provenance 回读通过 |
| SG9 | 官方插件替换手册 | Release 下载、profile 安装、Cordis provider 替换、验证和回滚步骤可直接执行 | 完成 | `docs/manual/replace-official-plugin.md`；关键 patch 与实际 Resident dump-config 一致 |
| SG10 | 已闭合步骤孤儿调用最大范围 | 普通边界不放宽；closed-step orphan 仅在最终摘要输入中临时配对；真实模型必须在 Web 恢复追加 end-seed 前完成语义保真 replacement | 完成 | `round-6.md`：真实模型覆盖 880 nodes，131,393 → 13,527 tokens |
| SG11 | 恢复前真实模型一次性 repair | 提供显式入口，在 Web 恢复前读取完整历史 surface、调用真实模型、原子持久化标准 replacement，并由 Web 继续恢复同一 Session ID | 进行中 | repair 入口、真实模型、原子输出与重载已通过；尚未让 Resident 从 repaired 输出恢复并续聊 |
| SG12 | 合并 PR #3 并发布新版本 | PR checks 全绿后合并；以包版本创建新 tag，Release 资产、校验和与 provenance 可回读 | 进行中 | 用户已授权合并与新 tag；待实时回查后执行 |

## 当前检查点

- 当前子目标：SG12
- 唯一下一步：回查 PR #3 checks 后合并，等待 main CI，再创建与 package version 一致的新 tag 并验证 Release 资产。
- 未闭环项：生产 Session 尚未替换；Web/Resident 已停止；health/API/UI 与真实消息续聊未验证。

## 进展

- 2026-08-27：读取交接材料与本机项目约束；确认工作区仅有交接文件且不是 Git 仓库；拉取官方 master 并固定提交 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`；代码搜索确认普通错误与固定保留预算循环仍存在。
- 2026-08-27：独立基线 122/122；实现类型化错误、三档扩张、单检查去重与跨 turn generation 缓存；当前 126/126，build/pack/隔离安装通过。真实 Session 副本证明三档预算均为同一 843-token range，两次压力检查只调用一次摘要器，但没有 replacement。
- 2026-08-27：建立 `zzusp/dsh-compaction-convergent` 公共仓库与 PR #1；commit 标识包安装到 Resident profile，实际 import、关键文件和 dump-config 证明新 provider 已替换官方 provider。服务仍停止，运行态与消息未验证。
- 2026-08-27：用户要求合并 PR，并接入 GitHub 自动构建、创建 tag 和发布产物；新增 SG8，发布链必须在 checks 全绿后合并，并以 Release asset 回读作为产物证据。
- 2026-08-27：新增 Windows Node 24 CI/Release workflow、版本 `0.1.1-rc.2-convergent.1` 和官方插件替换手册；本地等价门禁、pack/hash/provenance 通过，等待远端 PR checks。
- 2026-08-27：按交接校准 SG5：真实 Session 副本验收已经执行完毕，结果为负向边界而非恢复成功；`matrix.csv` 继续保留 `real-session-copy-new-replacement=FAIL`。PR Actions run `33058238853` 已触发，回查时仍为 `in_progress`。
- 2026-08-27：PR #1 在 PR checks 全绿后合并为 `7e71e19f2b688cfc30e994036fbfbffe009dbf0c`；main run `33058350188` 与 tag run `33058483163` 均成功。Tag `v0.1.1-rc.2-convergent.1` 发布三个资产，下载 tgz 的 SHA-256 为 `23d348b18a8a2a95f253cb758fbd9dba460304a9256d537d717ae3613141ba5c`，与校验文件及 provenance 一致。
- 2026-08-27：用户要求修复范围选择并用原问题 Session 的新副本验证；新增 SG10。已定位 `retainTokens=0` 仍先保留最新节点，使零预算无法覆盖整个最新闭合 surface，原先“历史 Session 本身无法收敛”的结论需由本轮实跑重新判定。
- 2026-08-27：进一步反证发现最大范围仍只有 843 tokens；真实根因是 `seq 338` 两个已闭合步骤 `group_task_create` 调用从未落 result，造成其后所有官方计数边界永久不平衡。修复仅在最终摘要输入中临时闭合这类孤儿调用；问题 Session 新副本完成 replacement，131,393 → 11,926 tokens，持久化重载及后续消息追加通过，原 Session 哈希不变。
- 2026-08-27：提交 `48e6398` 并创建 PR #3；远端 Node 24 run `33062368121` 完成 typecheck、128 tests、build、pack 与 artifact 上传，结论 SUCCESS。PR 回读为 OPEN / MERGEABLE。
- 2026-08-27：用户要求只安装、不启动。当前 PR artifact 已安装到 Resident，实际 import 回读 `0.1.1-rc.2-convergent.2 / Node v24.19.0`；安装/source `lib/region.js` SHA-256 同为 `76B6E6068E9BE40EBE43ACC6DD4A0F626CFBC1F1E5A86B9EE701CD5DAAFA3C34`，dump-config 保持官方 provider disabled、新 provider inserted。`3080/18998` 无监听，未声称运行态成功。
- 2026-08-27：应用侧真实回合证明 Web provider 已接管并执行两次收敛尝试，但恢复时追加的 `session/end-seed` 将在线 surface 截为约 843 tokens，provider 看不到历史 880 nodes。Resident 已修正为切换 preset 不建 seed 副本、不换 Session ID，但不能绕过 DSH 恢复边界。撤回“问题 Session 已恢复”结论：确定性占位摘要只证明 replacement 事务，不能作为真实语义验证。
- 2026-08-27：新增一次性 `repair` Cordis 入口，强制输入哈希、Session ID、独立输出与原子重载校验。真实 adapter 先后暴露 pressure 阈值漂移、代理开关和单次全量请求溢出；最终采用工具配对平衡的分层真实摘要，问题副本 131,393 → 13,527 tokens，880 nodes replacement，八段摘要齐全。原 Session 已恢复为 `AA97…`，Web 停止且 patch 恢复。
- 2026-08-27：repair 实现提交 `3632207` 并推送 PR #3；GitHub Node 24 run `33067193298` 完成 130 tests、typecheck、build、pack，结论 SUCCESS。PR 正文已按真实模型证据更新并回读为 OPEN / MERGEABLE。
- 2026-08-27：用户授权合并 PR #3 并发布新 tag；新增 SG12，发布完成以合并 SHA、main/tag Actions、Release 资产和校验和回读为准。

## 重大决策

- 以官方完整 `compaction-basic` 包为基线重命名，不 monkey patch、不重写事务层；原因是官方只开放 summarizer 子类钩子，范围选择和事务语义必须整体兼容。
- 第一版将扩张预算固定为 `[1, 0.5, 0]`，暂不公开新配置；减少配置面并直接覆盖已确认故障。
- 失败范围缓存以 `Session` 弱引用保存，并用 `surface.replaceGeneration` 自动换代；既不跨 Session 泄漏，也不会在表层已前进后错误熔断新尝试。
- 首次范围扩张和熔断继续保留；本轮不把 `retainTokens=0` 全局改成整面压缩，因为回归证明这会破坏 overflow 保留最新完整步骤。最大整面候选只在普通范围发生不缩小后启用，且仅容忍已有持久化 `step/end` 的孤儿调用。
- 恢复前 repair 不复用自动 pressure 阈值；它显式选择最大历史 surface。单次真实请求超过窗口时按工具配对平衡边界分块摘要，再递归合并，最终只提交一次标准 replacement；输入永不覆盖。

## 重要信息

- 现场版本为 DSH `0.1.1-rc.2`；原 Web/Resident 已停止，端口 `3080`、`18998` 无监听是交接时点事实，需实时回查。
- 故障 Session 文件：`C:\Users\64554\.dsh\sessions\--D-baibu-agent--\session-group-00fb7328cc47085feddbf03e-87f62c1b\session.jsonl`，只能复制后隔离测试。
