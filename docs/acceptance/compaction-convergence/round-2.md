# Round 2：公共仓库、PR 与 Resident 安装

## 结论

公共仓库和 PR 已建立；commit 标识 `.tgz` 已安装到 Resident profile，实际模块与合成配置均确认新 provider 生效。Resident/Web 未启动，端口无监听，因此本轮不包含运行态或真实消息 E2E。

## PASS 证据

- GitHub 仓库：`zzusp/dsh-compaction-convergent`，visibility 为 `PUBLIC`，默认分支为 `main`。
- PR #1：`main <- feature/compaction-convergence`，创建回查为 `OPEN / MERGEABLE`（后续 push 后 mergeability 需等待 GitHub 重算）。
- commit 标识包：`@zzusp/dsh-compaction-convergent@0.1.1-rc.2-convergent.6fc1379`；重新执行 typecheck、126 tests、build、pack 均通过。
- Resident 依赖：实际 package import 返回上述 name/version，入口解析到 Resident profile 的 `node_modules`。
- Resident 关键代码：已安装 `lib/index.js` 可读回 `expansionBudgets`、`failedRanges` 和明确诊断。
- Resident 合成配置：官方 `compaction-basic` 为 `disabled: true`；新增 `compaction-convergent` 指向 `@zzusp/dsh-compaction-convergent`。
- 回滚备份：安装前 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 已备份到用户 DSH backups 下的本轮时间戳目录。

## 首次失败及修正

- 最初尝试用同一 id 改 `name`，`dump-config` 仍显示官方 provider。读取 `cordis-plugin-include` 官方实现后确认 `name` 是匹配保护条件而不是可覆盖字段。
- 改为明确禁用官方 `compaction-basic`，并插入新 id `compaction-convergent`；再次 `dump-config` 后 provider 替换成立。
- `dsh plugin add` 报 bundle peer 依赖 warning；该 profile 的 bundle peers 由 DSH 宿主提供。没有把安装回执当生效证据，最终以实际 import、关键文件和 dump-config 三项回读为准。

## 未通过边界

- `18998` 与 `3080` 当前均无监听；Resident/Web 未启动。
- 未执行 health、API、UI smoke。
- 未恢复原 Resident Session，未执行真实钉钉消息收发与回读。
