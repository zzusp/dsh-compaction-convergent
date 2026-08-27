import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from '../../../../lib/region.js'

const sessionPath = process.argv[2]
const retainTokens = Number(process.argv[3])
if (sessionPath === undefined || !Number.isInteger(retainTokens) || retainTokens < 0) {
  throw new Error('Usage: node inspect-session.mjs <session.jsonl> <retainTokens>')
}

const lines = readFileSync(sessionPath, 'utf8').trimEnd().split(/\r?\n/)
const header = JSON.parse(lines.shift())
const events = lines.map(line => JSON.parse(line))
const session = Session.create(SessionId(`${header.id}-inspection`), events)
const ctx = new Context()
void new LlmRuntime(ctx)
void new TokenMeter(ctx)
const measurement = ctx.tokenMeter.measure(session)
const budgets = [...new Set([retainTokens, Math.floor(retainTokens / 2), 0])]
const ranges = budgets.map((budget) => {
  const range = selectCompactableRange(session, measurement, budget)
  if (range === null) return { budget, range: null }
  const selected = measurement.nodes.filter(node => node.seq >= range.start && node.seq <= range.end)
  return {
    budget,
    range,
    nodes: selected.length,
    tokens: selected.reduce((total, node) => total + node.tokens, 0),
  }
})

console.log(JSON.stringify({
  sourceId: header.id,
  eventCount: events.length,
  surfaceNodes: session.surface.nodes.length,
  replaceGeneration: session.surface.replaceGeneration,
  totalTokens: measurement.totalTokens,
  surfaceTokens: measurement.nodes.reduce((total, node) => total + node.tokens, 0),
  target: session.requestHeader()?.config,
  ranges,
}, null, 2))
