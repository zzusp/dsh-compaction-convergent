# 摘要输入容量收敛验收报告

## 结果

`matrix.csv` 的 14 个用例在 round 1 全部通过，Issue #4 的源码修复达到提交条件。

实现同时覆盖两层防线：已知模型容量时，在模型调用前对 system、tools、选中 messages、压缩指令和 `maxTokens` 输出预留进行完整计量；provider 仍报告 `CONTEXT_WINDOW_EXCEEDED` 时，按更小 balanced prefix 收敛并缓存失败范围。单个不可分割 unit 无法容纳时，以 `OversizedSurfaceUnitError` 有限终止。

## 回归范围

- 自动 pressure 与 context-overflow。
- `SummaryNotSmallerError` 扩大范围策略。
- tool-call/result 平衡边界与 closed-step orphan。
- 手工压缩、历史 repair、持久化重载、取消和真实 agent loop 重试。
- TypeScript、136 个测试、覆盖率、构建与 npm 包内容。

## 边界

这是源码、确定性 adapter、真实 agent loop harness 和包构建层验收；不等同于匿名化现场 Session 的真实 provider 修复或生产部署验证。
