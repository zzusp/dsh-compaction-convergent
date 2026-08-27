# Round 4：合并、Tag 与 Release 产物回读

## 结论

PR #1 已合并；PR、main 与 tag 三次 GitHub Actions 均通过。Tag `v0.1.1-rc.2-convergent.1` 已创建并发布三个 Release 资产，下载后的 tgz 哈希、provenance、包版本和替换手册均完成独立回读。

## PASS 证据

- PR #1：`MERGED`，合并提交 `7e71e19f2b688cfc30e994036fbfbffe009dbf0c`。
- PR run `33058238853`：成功。
- main run `33058350188`：成功，head SHA 为合并提交。
- tag run `33058483163`：Node 24 质量/打包 job 与 Release 发布 job 均成功。
- Release：`https://github.com/zzusp/dsh-compaction-convergent/releases/tag/v0.1.1-rc.2-convergent.1`，非 draft。
- tgz：`zzusp-dsh-compaction-convergent-0.1.1-rc.2-convergent.1.tgz`，34,478 bytes。
- SHA-256：`23d348b18a8a2a95f253cb758fbd9dba460304a9256d537d717ae3613141ba5c`；下载文件、`.sha256` 与 `provenance.json` 三方一致。
- provenance：repository、tag ref 和 commit 均指向本次发布；包内 `package.json` 版本为 `0.1.1-rc.2-convergent.1`。
- 包内容包含 `package/docs/manual/replace-official-plugin.md`。

## 保留边界

- 本轮没有启动 Resident/Web，也没有执行真实消息回读；这些结果仍为 FAIL，不能由 Release 成功替代。
- GitHub runner 报告 actions v4 内置 Node 20 已弃用、由 runner 强制使用 Node 24 的 warning；项目自身的 setup-node、依赖安装、测试和构建均使用 Node 24，warning 不影响本次成功结论。
