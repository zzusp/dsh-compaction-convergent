import { describe, expect, it } from 'vitest'
import { resolveConfig, resolveTargetPolicy, resolveCompactSpec } from '../src/config.ts'
const target = { provider: 'fixture', model: 'fixture' }
describe('alpha.2 routed output and headroom budgets', () => {
  it('keeps convergent summary and retention defaults while accounting for routed output', () => {
    const policy = resolveTargetPolicy(resolveConfig({}), target)
    expect(policy.maxTokens).toBe(8192)
    expect(policy.headroomTokens).toBe(0)
    const spec = resolveCompactSpec(policy, 100_000, 30_000)
    expect(spec.thresholdTokens).toBe(70_000)
    expect(spec.retainTokens).toBe(11_200)
  })
  it('accepts exact-target headroom overrides without altering summary caps', () => {
    const policy = resolveTargetPolicy(resolveConfig({ headroomTokens: 1000, modelPolicies: [{ ...target, headroomTokens: 5000 }] }), target)
    expect(resolveCompactSpec(policy, 100_000, 30_000).thresholdTokens).toBe(65_000)
    expect(policy.maxTokens).toBe(8192)
  })
  it.each([-1, 0.5, Number.NaN, Infinity])('rejects invalid headroom %s', value => {
    expect(() => resolveConfig({ headroomTokens: value })).toThrow(/headroomTokens/)
  })
  it('rejects exhausted budgets and invalid output reservations', () => {
    const policy = resolveTargetPolicy(resolveConfig({ headroomTokens: 1000 }), target)
    expect(() => resolveCompactSpec(policy, 1000)).toThrow(/no pressure budget/)
    expect(() => resolveCompactSpec(policy, 1000, -1)).toThrow(/non-negative integer/)
    expect(() => resolveCompactSpec(policy, 1000, 1000)).toThrow(/no pressure budget/)
  })
})
