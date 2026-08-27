# Round 5：已闭合步骤孤儿调用与问题 Session 副本

## 结论

首次“降低保留预算”修复继续保留；本轮补上两个已结束旧步骤工具调用缺失 result 的最大范围能力。确定性占位摘要证明该范围能够完成 replacement 事务、持久化和重载，但它会丢失真实语义，不能作为问题 Session 已修复的证据。真实 Web 恢复又追加 `session/end-seed`，在线 provider 只能看到边界后的约 843-token surface，因此真实 Session 仍未压缩。

## 根因证据

- 原 Session：41,454 events、880 surface nodes、131,393 total tokens、120,665 surface tokens。
- surface 中共有 60 个 tool calls、58 个 tool result events，最终欠 2。
- 两个孤儿调用均来自 assistant message `seq 338`，名称均为 `group_task_create`；对应 step 已有持久化 `step/end`，整份日志没有对应 result。
- 原算法所有三档预算只能选择 `31636:31636`，1 node / 843 tokens。

## 事务层 PASS 证据

- 最大候选范围：`31636:41446`，880 nodes / 120,665 tokens。
- 只在摘要输入中为两个 closed-step orphan calls 插入 synthetic error results；原 Session 和副本事件中均不补写 `tool/result`。
- 问题副本：`131,393 → 11,926 tokens`，replace generation `7 → 8`，surface `880 → 1`。
- replacement shadowed 880 nodes / 120,665 tokens；第二次压力检查返回 `null`，没有继续压缩。
- 持久化副本重新加载后仍为 11,926 tokens，并成功追加 `post-compaction continuation probe`；这只证明结构可重载，不证明摘要语义可续接。
- 原 Session 验证前后 SHA-256 均为 `AA97FDF4F30AB03E96804435A55E6BCBD8808051F08ACC940269502725527F3F`。
- 副本路径：`C:\Users\64554\AppData\Local\Temp\dsh-compaction-convergent-sg10\session-problem-copy.jsonl`。
- Node 24：typecheck、128/128 tests、coverage gate、build 通过。
- 待发布包版本：`0.1.1-rc.2-convergent.2`。
- `npm pack`：18 files、35,973 bytes；SHA-256 `1EEEDD6621D057AE03C416C507E330B2BABD7E0FF85F9915733E3F069264EEAF`，包内包含官方插件替换手册。
- GitHub PR #3 首次 run `33062368121`：Node 24 quality and package SUCCESS，远端完成 typecheck、tests、build、pack 与 artifact 上传。
- Resident 安装回读：`@zzusp/dsh-compaction-convergent 0.1.1-rc.2-convergent.2 / Node v24.19.0`；安装/source `lib/region.js` SHA-256 均为 `76B6E6068E9BE40EBE43ACC6DD4A0F626CFBC1F1E5A86B9EE701CD5DAAFA3C34`。
- `dump-config`：官方 `compaction-basic` 为 `disabled: true`，`compaction-convergent` 指向本包。用户将范围收窄为只安装，未启动服务；`3080/18998` 无监听。

## 边界

- 本轮使用确定性占位摘要器验证真实 Session 数据上的范围选择、事务、replacement、持久化与重载；占位内容不保留真实语义，禁止用于真实会话 repair。
- Web provider 的真实回合接管已确认，但恢复后的 `session/end-seed` 让其看不到旧的 880-node surface；两次收敛尝试仍只能处理约 843 tokens。
- 根治尚需一次性、真实模型、Web 恢复前的 repair/compact 入口。
- 当前开放步骤的未回答调用仍拒绝最大范围；正常 overflow 和手动压缩仍保留最新完整工具配对。
- 未修改原问题 Session，未启动 Resident/Web，未执行真实消息回读。
