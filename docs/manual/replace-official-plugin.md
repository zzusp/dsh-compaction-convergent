# 替换官方压缩插件

本插件提供与 `@deepseek-ai/dsh-compaction-basic` 相同的 `ctx.compaction` 服务。一个 profile 中只能启用一个 compaction provider，因此必须先禁用官方插件，再插入本插件。

## 1. 下载 Release 产物

要求 Node.js 24，并将 `<version>` 替换为目标 Release（例如 `v0.1.1-rc.2-convergent.1`）：

```powershell
$releaseDir = Join-Path $PWD 'dsh-compaction-release'
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
gh release download <version> `
  --repo zzusp/dsh-compaction-convergent `
  --pattern '*.tgz' `
  --pattern '*.sha256' `
  --pattern 'provenance.json' `
  --dir $releaseDir
```

先核对 `.sha256` 与 `provenance.json`，确认其中的 commit、tag 和下载的 `.tgz` 属于同一次 Release。

## 2. 安装到目标 profile

以下示例使用 `resident` profile：

```powershell
$package = Get-ChildItem -LiteralPath $releaseDir -Filter '*.tgz' | Select-Object -Single
dsh plugin --profile resident add $package.FullName
```

该命令只把包装进 profile；它不会自动替换 bundle 内的官方 provider。

## 3. 修改 `cordis.patch.yml`

在 `%USERPROFILE%\.dsh\profiles\resident\cordis.patch.yml` 的顶层 patch 列表加入：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: true

- insert:
    - id: compaction-convergent
      name: '@zzusp/dsh-compaction-convergent'
      config:
        thresholdRatio: 0.8
        retainRatio: 0.16
        maxTokens: 8192
        compactionRetries: 1
        maxOverflowRetries: 1
```

不要写成下面这样：

```yaml
- id: compaction-basic
  name: '@zzusp/dsh-compaction-convergent'
```

Cordis Include 的 `name` 是目标匹配保护条件，不是可覆盖字段；这样写会因名称与官方 entry 不匹配而跳过 patch。

`token-meter`、`command-compact` 和 `tool-result-pruner` 保持官方配置，不要再注册第二份。

## 4. 启动前验证

```powershell
dsh --profile resident --dump-config
```

输出必须同时满足：

- `compaction-basic` 仍指向 `@deepseek-ai/dsh-compaction-basic`，但带有 `disabled: true`；
- 存在 `compaction-convergent`，并指向 `@zzusp/dsh-compaction-convergent`；
- 没有第二个启用状态的 compaction provider。

再从 profile 目录回读实际安装版本：

```powershell
Push-Location "$env:USERPROFILE\.dsh\profiles\resident"
node --input-type=module -e "import meta from '@zzusp/dsh-compaction-convergent/package.json' with { type: 'json' }; console.log(meta.name, meta.version)"
Pop-Location
```

安装回执或 `dump-config` 单项都不足以证明运行态。启动后还应分别检查目标进程使用 Node 24、listener、health/API，以及实际 Session 行为。

## 5. 回滚

先停止目标 profile，然后删除 `compaction-convergent` 插入项，并将官方 patch 改回启用：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  disabled: false
```

确认 `dump-config` 只启用官方 provider 后再启动。回滚不修改 Session 日志格式或既有 checkpoint。
