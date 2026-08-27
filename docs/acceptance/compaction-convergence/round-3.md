# Round 3：GitHub Actions 与发布链准备

## 结论

已新增 PR/main 自动质量门禁和 tag Release 构建链，并把包版本固定为 `0.1.1-rc.2-convergent.1`。本地执行 workflow 等价命令、pack provenance 与官方 provider 替换手册验证通过；真实 GitHub Actions、合并、tag 和 Release asset 仍待远端运行，不能提前记为 PASS。

## PASS 证据

- workflow YAML 使用 `js-yaml` 实际解析通过。
- Node `v24.19.0` 下 `npm ci` 通过，审计为 0 vulnerabilities。
- `npm run typecheck` 通过。
- `npm run test:coverage`：4 files、126 tests 全绿，语句/分支/函数/行覆盖率均 100%。
- `npm run build` 通过。
- `npm pack` 生成 `zzusp-dsh-compaction-convergent-0.1.1-rc.2-convergent.1.tgz`；本地流程同时生成 SHA-256 文件和 `provenance.json`，后者包含 repository、完整 commit、ref、package 和 sha256。
- tag 门禁本地验证：`v0.1.1-rc.2-convergent.1` 与 `package.json` version 严格相等。
- 替换手册中的 Cordis 结构与本机 Resident 已验证配置一致：官方 provider disabled，新 provider 使用独立 id 插入。

## 待远端验证

- PR workflow 真实 Windows runner 尚未运行。
- PR 尚未合并，main push workflow 尚未运行。
- tag 尚未创建，Release job 与资产下载/哈希回读尚未发生。
