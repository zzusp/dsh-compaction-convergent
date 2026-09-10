# Round 1：保留预算与摘要调用回归

## 结果

2026-09-10，本地验证通过；真实 provider 延迟和摘要语义续接未执行。只读事件范围对照不等同于模型摘要或源会话恢复。

## 证据

- `npm run typecheck`：退出码 0。
- `npm run test:coverage`：5 files / 153 tests PASS；statements 90.97%、branches 89.14%、functions 94.61%、lines 92.26%。
- `npm run build`、`npm pack --dry-run`：退出码 0；22 files，53.7 kB，unpacked 193.0 kB。
- 参数测试覆盖 1k、32k、272k、872k 窗口的隐式上限，以及显式比例、绝对预算和精确路由覆盖。
- 272k 窗口自动压缩对照：默认实际保留量在 12k–16k，旧显式 16% 至少保留 43,520；新结果比旧结果少超过 28k token。两条路径均只调用一次测试摘要器，日志重载计数一致，追加消息成功。该测试不验证摘要语义。
- 原生 adapter 元数据回归：公开 low 时实际 stream 参数为 low；不公开或缺少推理元数据时不传不支持的值。元数据从不支持 low 变为支持 low 后 capacityKey 改变，估算与派发 envelope 一致。
- 私有历史事件范围对照：选择首个压缩前（seq 16752）的事件，用 DSH 原生 decodeSeqRanges/decodeStorageRecord 解码并在新内存 Session 上重放。旧策略保留 47,953 / 选中 93,766 token（107 nodes）；新默认保留 14,111 / 选中 127,608 token（198 nodes）。源文件 SHA-256 前后一致。没有调用 provider、写回日志、恢复原 Session 身份或部署。

## 验证中的修正

- 第一轮新增推理测试只 mock 了服务查询，但真实 stream 在 adapter prepareCall 上再次校验能力；改为让 adapter 本身公开能力，保留完整派发链路后通过。
- 新提示词占用更多固定输入，原 1,800-token 单块 fixture 会合法产生多块。将该 fixture 调整到 2,000，仍验证包含 system/tools 的请求必须缩小范围、一次派发成功且再加一个节点必定超窗。
- 历史 JSONL 的 sourceEventSeqs 为压缩存储形式，不能直接作为 SessionEvent 解析；使用原生解码。原始旧 header 不满足当前 Session 构造校验，因此范围对照只在新内存 Session 重放事件，不冒充完整历史会话恢复。

## 未覆盖与风险

- 较少近期原文意味着更多历史交给摘要器，单次输入可能增加；low 和短摘要提示的净耗时收益需真实模型 A/B 验证。
- 1,500 token 是软目标；完整八段结构及关键续接事实优先，8,192 输出上限和截断失败语义未变。
- 系统提示、工具定义和工具配对边界决定实际占用下限；不能承诺所有会话低于某个百分比。
- 显式 retainRatio: 0.16 不会自动迁移；安装手册已记录启用新默认及回滚方式。未发布、未改生产 profile。
