import { readFileSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '../../../../lib/index.js'

const sessionPath = process.argv[2]
const persist = process.argv[3] === '--persist'
if (sessionPath === undefined) {
  throw new Error('Usage: node validate-session-copy.mjs <copied-session.jsonl>')
}

const lines = readFileSync(sessionPath, 'utf8').trimEnd().split(/\r?\n/)
const header = JSON.parse(lines.shift())
const events = lines.map(line => JSON.parse(line))
const session = Session.create(SessionId(`${header.id}-convergence-validation`), events)
const nextTurn = Math.max(0, ...events
  .filter(event => event.type === 'turn/start')
  .map(event => event.data.turn)) + 1
session.append('turn/start', { turn: nextTurn })

class FixedContextAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 160_664 },
    })
  }

  async * stream() {
    throw new Error('the deterministic validation subclass must not call ctx.llm.stream()')
  }
}

class VerboseCompactionEngine extends BasicCompactionEngine {
  calls = 0

  summarize() {
    this.calls += 1
    return Promise.resolve({
      summary: Array.from({ length: 100 }, (_, index) => ({
        type: 'text',
        text: `non-shrinking checkpoint ${index}`,
      })),
      provider: 'validation',
      model: 'deterministic',
    })
  }
}

const ctx = new Context()
void new LlmRuntime(ctx)
void new TokenMeter(ctx)
ctx.llm.registerAdapter(['openai-codex'], new FixedContextAdapter())
const compact = new VerboseCompactionEngine(ctx, {
  auto: false,
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  compactionRetries: 1,
})
const agent = {
  session,
  options: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
}
const signal = new AbortController().signal
const generation = session.surface.replaceGeneration
const totalTokensBefore = ctx.tokenMeter.measure(session).totalTokens
const outcomes = []
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    const compacted = await compact.compactIfNeeded(agent, 'pressure', signal)
    outcomes.push(compacted === null ? null : {
      shadowedTokenCount: compacted.shadowedTokenCount,
      shadowedNodes: compacted.shadowedSeqs.length,
    })
  } catch (error) {
    outcomes.push({ error: error instanceof Error ? error.message : String(error) })
  }
}

const totalTokensAfter = ctx.tokenMeter.measure(session).totalTokens
if (persist) {
  writeFileSync(sessionPath, [JSON.stringify(header), ...session.events.map(event => JSON.stringify(event)), ''].join('\n'))
}
const reloaded = Session.create(SessionId(`${header.id}-convergence-reload`), session.events)
const reloadedTokens = ctx.tokenMeter.measure(reloaded).totalTokens
reloaded.append('user/message', createUserMessage({
  content: [{ type: 'text', text: 'post-compaction continuation probe' }],
  source: { kind: 'plugin', plugin: 'dsh-compaction-convergent-validation' },
}), { surfaceOp: 'append' })
const continuation = reloaded.deriveMessages().at(-1)?.content

const result = {
  sourceId: header.id,
  copiedPath: sessionPath,
  totalTokensBefore,
  totalTokensAfter,
  reloadedTokens,
  replaceGenerationBefore: generation,
  replaceGenerationAfter: session.surface.replaceGeneration,
  summarizerCallsAcrossTwoPressureChecks: compact.calls,
  surfaceNodesAfter: session.surface.nodes.length,
  persisted: persist,
  continuation,
  outcomes,
}
console.log(JSON.stringify(result, null, 2))

if (compact.calls !== 2
  || session.surface.replaceGeneration !== generation + 1
  || totalTokensAfter >= totalTokensBefore
  || reloadedTokens !== totalTokensAfter
  || continuation?.[0]?.type !== 'text'
  || continuation[0].text !== 'post-compaction continuation probe'
  || outcomes[0] === null
  || typeof outcomes[0] !== 'object'
  || 'error' in outcomes[0]
  || outcomes[1] !== null) {
  process.exitCode = 1
}
