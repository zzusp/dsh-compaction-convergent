/**
 * One-shot, pre-recovery repair entry for a persisted DSH Session copy.
 *
 * This Cordis plugin deliberately runs during plugin setup: the Resident must
 * stay disabled until the repaired output has been written and verified.
 * @module @zzusp/dsh-compaction-convergent/repair
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from './index.ts'

export interface RepairConfig {
  readonly inputPath: string
  readonly outputPath: string
  readonly reportPath: string
  readonly expectedSha256: string
  readonly expectedSessionId: string
  readonly timeoutMs?: number
}

export interface RepairReport {
  readonly semanticValidation: true
  readonly sourceSha256: string
  readonly sessionId: string
  readonly inputEvents: number
  readonly outputEvents: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly shadowedNodes: number
  readonly shadowedTokens: number
  readonly replaceGenerationBefore: number
  readonly replaceGenerationAfter: number
  readonly provider: string
  readonly model: string
}

interface PersistedSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
}

/** Cordis plugin name. */
export const name = 'compaction-convergent-repair'
/** The selected compaction provider and token meter must already be installed. */
export const inject = ['compaction', 'tokenMeter']

export const Config: z<RepairConfig> = z.object({
  inputPath: z.string().required(),
  outputPath: z.string().required(),
  reportPath: z.string().required(),
  expectedSha256: z.string().required(),
  expectedSessionId: z.string().required(),
  timeoutMs: z.number().step(1).min(1),
})

function parseSession(raw: string): PersistedSession {
  const lines = raw.trimEnd().split(/\r?\n/)
  if (lines.length < 2) throw new Error('repair input must contain a header and at least one event')
  const [headerLine, ...eventLines] = lines
  return {
    header: JSON.parse(headerLine!) as SessionHeader,
    events: eventLines.map(line => JSON.parse(line) as SessionEvent),
  }
}

async function assertMissing(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.F_OK)
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} already exists: ${path}`)
}

async function atomicCreate(path: string, content: string): Promise<void> {
  await assertMissing(path, 'repair destination')
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Repair one exact persisted copy through the profile's real compaction provider.
 * The input is immutable and the output is created only after a successful replacement.
 */
export async function repairSessionCopy(ctx: Context, config: RepairConfig): Promise<RepairReport> {
  const inputPath = resolve(config.inputPath)
  const outputPath = resolve(config.outputPath)
  const reportPath = resolve(config.reportPath)
  if (inputPath === outputPath || inputPath === reportPath || outputPath === reportPath) {
    throw new Error('repair input, output, and report paths must be distinct')
  }
  if (dirname(inputPath) !== dirname(outputPath)) {
    throw new Error('repair output must be a sibling of the input copy')
  }
  await assertMissing(outputPath, 'repair output')
  await assertMissing(reportPath, 'repair report')

  const raw = await readFile(inputPath, 'utf8')
  const sourceSha256 = createHash('sha256').update(raw).digest('hex')
  if (sourceSha256.toLowerCase() !== config.expectedSha256.toLowerCase()) {
    throw new Error(`repair input SHA-256 mismatch: received ${sourceSha256}`)
  }

  const persisted = parseSession(raw)
  if (persisted.header.id !== config.expectedSessionId) {
    throw new Error(`repair Session ID mismatch: received ${persisted.header.id}`)
  }
  const session = Session.create(SessionId(config.expectedSessionId), persisted.events, persisted.header)
  const routed = session.requestHeader()?.config
  if (routed === undefined) throw new Error('repair Session has no durable request route')

  const nextTurn = Math.max(0, ...persisted.events
    .filter((event): event is SessionEvent<'turn/start'> => event.type === 'turn/start')
    .map(event => event.data.turn)) + 1
  session.append('turn/start', { turn: nextTurn })

  const tokensBefore = ctx.tokenMeter.measure(session).totalTokens
  const replaceGenerationBefore = session.surface.replaceGeneration
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('repair compaction timed out')),
    config.timeoutMs ?? 600_000,
  )
  let result
  try {
    if (!(ctx.compaction instanceof BasicCompactionEngine)) {
      throw new Error('repair requires @zzusp/dsh-compaction-convergent as the active provider')
    }
    const agent = {
      session,
      options: { provider: routed.provider, model: routed.model },
    } as Agent
    result = await ctx.compaction.compactHistoricalSurface(agent, controller.signal)
  } finally {
    clearTimeout(timeout)
  }
  if (result === null || session.surface.replaceGeneration === replaceGenerationBefore) {
    throw new Error('repair provider completed without a replacement')
  }
  session.append('turn/end', { turn: nextTurn, reason: { kind: 'completed' } })

  const tokensAfter = ctx.tokenMeter.measure(session).totalTokens
  if (tokensAfter >= tokensBefore) {
    throw new Error(`repair replacement did not shrink the Session (${tokensBefore} -> ${tokensAfter})`)
  }
  const output = [JSON.stringify(persisted.header), ...session.events.map(event => JSON.stringify(event)), ''].join('\n')
  await atomicCreate(outputPath, output)

  const reloaded = parseSession(await readFile(outputPath, 'utf8'))
  const reloadedSession = Session.create(SessionId(config.expectedSessionId), reloaded.events, reloaded.header)
  const reloadedTokens = ctx.tokenMeter.measure(reloadedSession).totalTokens
  if (reloaded.header.id !== config.expectedSessionId || reloadedTokens !== tokensAfter) {
    await rm(outputPath, { force: true })
    throw new Error('repair output failed persistence reload verification')
  }

  const report: RepairReport = {
    semanticValidation: true,
    sourceSha256,
    sessionId: config.expectedSessionId,
    inputEvents: persisted.events.length,
    outputEvents: session.events.length,
    tokensBefore,
    tokensAfter,
    shadowedNodes: result.shadowedSeqs.length,
    shadowedTokens: result.shadowedTokenCount,
    replaceGenerationBefore,
    replaceGenerationAfter: session.surface.replaceGeneration,
    provider: routed.provider,
    model: routed.model,
  }
  await atomicCreate(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

/** Run exactly once while the repair plugin is being installed. */
export const apply = async (ctx: Context, config: RepairConfig): Promise<void> => {
  const report = await repairSessionCopy(ctx, config)
  ctx.logger.info(
    `pre-recovery Session repair completed: ${report.tokensBefore} -> ${report.tokensAfter} tokens, `
    + `${report.shadowedNodes} nodes shadowed`,
  )
}
