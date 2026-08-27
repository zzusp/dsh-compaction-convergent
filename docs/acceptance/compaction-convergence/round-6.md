# Round 6：恢复前真实模型 repair

## 结果

- Node：`v24.19.0`。
- 源 Session：41,454 events，17,055,995 bytes，SHA-256 `AA97FDF4F30AB03E96804435A55E6BCBD8808051F08ACC940269502725527F3F`。
- 第一次真实入口因自动 pressure 未达新模型阈值返回 null，未写输出；据此改为显式最大历史 surface。
- 第二次真实入口到达模型但缺少 `NODE_USE_ENV_PROXY=1`，以 `TRANSPORT/fetch failed` 失败，未写输出。
- 第三次单次最大摘要被真实 adapter 规范化为 `CONTEXT_WINDOW_EXCEEDED`，未写输出；据此增加工具配对平衡的分层摘要。
- 最终真实模型 `openai-codex/gpt-5.6-sol` 成功：131,393 → 13,527 tokens（下降 89.70%），880 nodes 被 replacement，generation 7 → 8。
- 输出重载为 13,527 tokens、1 surface node、同一 Session ID；摘要正文 10,787 characters，要求的八个 Markdown section 全部存在。
- 临时 Web 已停止，3080/18998 无监听；Web patch 已恢复。启动期间原 Session 仅被 Web 追加一个 `session/end-seed`，已从逐字节相同且哈希已校验的输入副本恢复，最终哈希重新为 `AA97…`。

## 边界

- 本轮证明真实模型语义摘要、标准 replacement、持久化重载与同 ID 输出成立。
- 尚未把 repaired 输出替换为生产 Session，也未启动 Resident 从该输出继续真实消息；`web-health-api-listener-ui` 与 `resident-real-message-readback` 继续为 FAIL。
