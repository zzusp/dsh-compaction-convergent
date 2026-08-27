import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { selectCompactableRange, selectMaximalCompactableRange } from '../../../../lib/region.js'

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
  const startIdx = measurement.nodes.findIndex(node => node.seq === range.start)
  const endIdx = measurement.nodes.findIndex(node => node.seq === range.end)
  const selected = measurement.nodes.slice(startIdx, endIdx + 1)
  return {
    budget,
    range,
    nodes: selected.length,
    tokens: selected.reduce((total, node) => total + node.tokens, 0),
  }
})
const maximalRange = selectMaximalCompactableRange(session, measurement)
const maximalNodes = maximalRange === null
  ? []
  : measurement.nodes.slice(
      measurement.nodes.findIndex(node => node.seq === maximalRange.start),
      measurement.nodes.findIndex(node => node.seq === maximalRange.end) + 1,
    )
let pairingBalance = 0
let lastBalancedSurfaceSeq = null
let assistantToolCalls = 0
let toolResultEvents = 0
const unmatchedCalls = []
for (const seq of session.surface.nodes) {
  const event = session.events[seq]
  if (event.type === 'assistant/message') {
    const calls = event.data.message.content.filter(block => block.type === 'tool-call').length
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call') unmatchedCalls.push({ seq, id: block.id, name: block.name })
    }
    assistantToolCalls += calls
    pairingBalance += calls
  } else if (event.type === 'tool/result') {
    toolResultEvents += 1
    pairingBalance -= 1
    const resultBlock = event.data.message.content.find(block => block.type === 'tool-result')
    const matchedIndex = unmatchedCalls.findIndex(call => call.id === resultBlock?.toolCallId)
    if (matchedIndex >= 0) unmatchedCalls.splice(matchedIndex, 1)
  }
  if (pairingBalance === 0) lastBalancedSurfaceSeq = seq
}

console.log(JSON.stringify({
  sourceId: header.id,
  eventCount: events.length,
  surfaceNodes: session.surface.nodes.length,
  replaceGeneration: session.surface.replaceGeneration,
  totalTokens: measurement.totalTokens,
  surfaceTokens: measurement.nodes.reduce((total, node) => total + node.tokens, 0),
  target: session.requestHeader()?.config,
  firstBoundaryBalanced: toolPairingBalancedBefore(session, session.surface.nodes[0]),
  lastBoundaryBalanced: toolPairingBalancedAfter(session, session.surface.nodes.at(-1)),
  pairing: {
    assistantToolCalls,
    toolResultEvents,
    finalBalance: pairingBalance,
    lastBalancedSurfaceSeq,
    unmatchedCalls,
  },
  ranges,
  maximalRange: maximalRange === null ? null : {
    range: maximalRange,
    nodes: maximalNodes.length,
    tokens: maximalNodes.reduce((total, node) => total + node.tokens, 0),
  },
}, null, 2))
