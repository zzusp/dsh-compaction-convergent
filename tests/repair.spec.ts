import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import { BasicCompactionEngine } from '../src/index.ts'
import type { SummarizationInput, SummaryResult } from '../src/summarizer.ts'
import { repairSessionCopy } from '../src/repair.ts'

class RepairAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    throw new Error('repair test summarizer must not stream')
  }
}

class RepairEngine extends BasicCompactionEngine {
  protected override summarize(_input: SummarizationInput): Promise<SummaryResult> {
    return Promise.resolve({
      summary: [{ type: 'text', text: 'Faithful compact test summary.' }],
      provider: 'repair-provider',
      model: 'repair-model',
    })
  }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = resolve(root)
    if (!resolved.startsWith(resolve(tmpdir()))) throw new Error(`refusing to remove unexpected path: ${resolved}`)
    await rm(resolved, { recursive: true, force: true })
  }
})

function persistedFixture(): { raw: string; sessionId: string } {
  const sessionId = 'repair-session'
  const session = Session.create(SessionId(sessionId))
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('request/header', {
        header: {
          config: { provider: 'repair-provider', model: 'repair-model' },
          system: 'repair system',
          tools: [],
        },
        reason: 'initial',
      })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `turn ${turn} ${'history '.repeat(80)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return {
    sessionId,
    raw: [JSON.stringify(session.header), ...session.events.map(event => JSON.stringify(event)), ''].join('\n'),
  }
}

async function repairContext(): Promise<Context> {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter(['repair-provider'], new RepairAdapter())
  void new RepairEngine(ctx, { auto: false, thresholdRatio: 0.5, retainRatio: 0.1 })
  return ctx
}

describe('pre-recovery Session repair', () => {
  it('creates a verified semantic replacement without modifying the input copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-convergent-repair-'))
    temporaryRoots.push(root)
    const inputPath = join(root, 'session.jsonl')
    const outputPath = join(root, 'session.repaired.jsonl')
    const reportPath = join(root, 'session.repair-report.json')
    const fixture = persistedFixture()
    await writeFile(inputPath, fixture.raw, 'utf8')
    const sha256 = createHash('sha256').update(fixture.raw).digest('hex')

    const report = await repairSessionCopy(await repairContext(), {
      inputPath,
      outputPath,
      reportPath,
      expectedSha256: sha256,
      expectedSessionId: fixture.sessionId,
    })

    expect(await readFile(inputPath, 'utf8')).toBe(fixture.raw)
    expect(report.semanticValidation).toBe(true)
    expect(report.tokensAfter).toBeLessThan(report.tokensBefore)
    expect(report.replaceGenerationAfter).toBe(report.replaceGenerationBefore + 1)
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report)
    expect(await readFile(outputPath, 'utf8')).toContain('Faithful compact test summary.')
  })

  it('fails closed on a source hash mismatch and creates no output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-convergent-repair-'))
    temporaryRoots.push(root)
    const inputPath = join(root, 'session.jsonl')
    const outputPath = join(root, 'session.repaired.jsonl')
    const reportPath = join(root, 'session.repair-report.json')
    const fixture = persistedFixture()
    await writeFile(inputPath, fixture.raw, 'utf8')

    await expect(repairSessionCopy(await repairContext(), {
      inputPath,
      outputPath,
      reportPath,
      expectedSha256: '0'.repeat(64),
      expectedSessionId: fixture.sessionId,
    })).rejects.toThrow('SHA-256 mismatch')
    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
