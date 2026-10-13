import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine as OfficialEngine } from 'official-alpha2-compaction'
import { BasicCompactionEngine as ConvergentEngine } from '../src/index.ts'
import { LlmAdapter, default as LlmRuntime, createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { installTokenMeter } from './setup.ts'

class FixedAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 1000 } }
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const summary: ContentBlock[] = Array.from({ length: 7 }, (_, i) => ({ type: 'text', text: `summary ${i}` }))
class OfficialFixture extends OfficialEngine {
  override async summarize() { return { summary, provider: 'fixture', model: 'fixture' } }
}
class ConvergentFixture extends ConvergentEngine {
  override async summarize() { return { summary, provider: 'fixture', model: 'fixture' } }
}
function fixture() {
  const ctx = new Context()
  new LlmRuntime(ctx)
  installTokenMeter(ctx)
  ctx.llm.registerAdapter(['fixture'], new FixedAdapter())
  const session = Session.create(SessionId('alpha2-cap-comparison'))
  const text = 'fixture '.repeat(40).trim()
  for (let turn = 1; turn <= 4; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${text} user ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: `${text} assistant ${turn}` }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  const agent = { session, options: { provider: 'fixture', model: 'fixture' } } as Agent
  return { ctx, session, agent }
}
const config = { auto: false, compactionRetries: 0, thresholdRatio: 0.3, retainTokens: 180, maxTokens: 8192 }
describe('released alpha.2 upstream versus convergent fixed-input comparison', () => {
  it('official backend stops after one shrinking replacement while still over threshold', async () => {
    const { ctx, session, agent } = fixture()
    try {
      await expect(new OfficialFixture(ctx, { ...config, headroomTokens: 0 }).compactIfNeeded(agent, 'pressure', new AbortController().signal)).rejects.toThrow(/still above threshold after 1 compaction attempts/)
      expect(session.surface.replaceGeneration).toBe(1)
      expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(300)
    } finally { await ctx.fiber.dispose() }
  })
  it('convergent backend finishes the same input beyond that successful-chunk cap', async () => {
    const { ctx, session, agent } = fixture()
    try {
      await expect(new ConvergentFixture(ctx, config).compactIfNeeded(agent, 'pressure', new AbortController().signal)).resolves.not.toBeNull()
      expect(session.surface.replaceGeneration).toBeGreaterThan(1)
      expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(300)
    } finally { await ctx.fiber.dispose() }
  })
})
