# Issue #7 验收报告

## 结果

`matrix.csv` Round 1 全部 PASS。修复将自动压缩从“固定成功次数”改为“单逻辑 job 持续到阈值以下”，并增加按完整摘要 envelope 隔离、跨 generation/engine 可恢复的容量学习。

## 核心保证

- 一次触发、一个 jobId、多个原子分块；每块都严格降低完整请求 token，最终块低于阈值才标记 completed。
- provider 拒绝和成功容量形成上下界；后续分块从接受上界扣安全余量，错误包含 token gap 时使用 gap，否则折半。
- 每个自动 attempt 的 job/范围/容量/指标随已有 `compaction/*` 日志记录；闭合后 flush，重建可继续。
- 旧 pressure、overflow、manual compaction、repair、事务锁和工具调用配对回归全部通过。

## 验证摘要

- TypeScript：PASS。
- Vitest：5 files / 143 tests PASS。
- Coverage：statements 90.88%，branches 89.03%，functions 94.48%，lines 92.18%。
- Build：PASS。
- Pack dry-run：22 files，52.1 kB，包含新 convergence 产物。

## 边界

本报告是源码与确定性本地测试验收，不等同于真实 922k Session 或生产 provider E2E；未执行部署，也未修改任何生产 Session。
