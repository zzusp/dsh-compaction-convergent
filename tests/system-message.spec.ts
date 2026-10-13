import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createSystemMessage, createUserMessage, LlmAdapter, LlmError, IMAGE_OFFLOAD_REQUIRED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as installImageOffload } from '@deepseek-ai/dsh-compaction-image-offload'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  compactSurfaceRegion,
  oldestCompactableSurfaceUnit,
  selectCompactableRange,
  selectLargestCompactablePrefix,
  selectMaximalCompactableRange,
} from '../src/region.ts'
import type { SummarizationInput } from '../src/summarizer.ts'
import { estimateDefaultSummaryEnvelope } from '../src/summarizer.ts'
import { installTokenMeter } from './setup.ts'

function fixture(system = 'persistent instructions') {
  const ctx = new Context()
  const meter = installTokenMeter(ctx)
  const session = Session.create(SessionId('system-head'))
  session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage(system),
  }, { surfaceOp: 'append' })
  for (let index = 0; index < 3; index++) {
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `history ${index} `.repeat(300) }],
    }), { surfaceOp: 'append' })
  }
  const agent = { session, options: { provider: 'test', model: 'test' } } as Agent
  return { ctx, meter, session, agent }
}

class ModelAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('alpha.2 system surface head', () => {
  it('excludes the system head from every automatic and capacity selection', () => {
    const { session, meter } = fixture()
    const measurement = meter.measure(session)
    const [head, first, , last] = session.surface.nodes
    expect(selectCompactableRange(session, measurement, 1)?.start).toBe(first)
    expect(selectMaximalCompactableRange(session, measurement)).toEqual({ start: first, end: last })
    expect(selectLargestCompactablePrefix(session, measurement, last!, Infinity)).toEqual({ start: first, end: last })
    expect(selectLargestCompactablePrefix(session, measurement, head!, Infinity)).toBeNull()
    expect(oldestCompactableSurfaceUnit(session, measurement)).toEqual({
      start: first, end: first, tokens: measurement.nodes[1]!.tokens,
    })
  })

  it('returns no range for a system-only surface', () => {
    const { session, meter } = fixture()
    const only = Session.create(SessionId('system-only'))
    const head = session.eventAt(session.surface.nodes[0]!)!
    if (head.type !== 'system/message') throw new Error('missing system fixture')
    only.append('system/message', head.data, { surfaceOp: 'append' })
    const measurement = meter.measure(only)
    expect(selectCompactableRange(only, measurement, 0)).toBeNull()
    expect(selectMaximalCompactableRange(only, measurement)).toBeNull()
    expect(selectLargestCompactablePrefix(only, measurement, only.surface.nodes[0]!, Infinity)).toBeNull()
    expect(oldestCompactableSurfaceUnit(only, measurement, true)).toBeNull()
  })

  it('rejects a manual range containing the system before opening a transaction', async () => {
    const { session, meter, agent } = fixture()
    const summarize = vi.fn()
    await expect(compactSurfaceRegion({ meter, summarize, recover: () => false }, session,
      session.surface.nodes[0]!, session.surface.nodes[1]!, agent,
      { owner: null, stability: 'selected-span' })).rejects.toThrow('system surface head cannot be compacted')
    expect(summarize).not.toHaveBeenCalled()
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('replays the system first while preserving it outside the replaced span', async () => {
    const { session, meter, agent } = fixture()
    const head = session.surface.nodes[0]!
    const summarize = vi.fn(async (_input: SummarizationInput) => ({
      summary: [{ type: 'text' as const, text: 'checkpoint' }], provider: 'test', model: 'test',
    }))
    await compactSurfaceRegion({ meter, summarize, recover: () => false }, session,
      session.surface.nodes[1]!, session.surface.nodes[2]!, agent,
      { owner: null, stability: 'selected-span' })
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ role: 'system' }, { role: 'user' }, { role: 'user' }],
    })
    expect(session.surface.nodes[0]).toBe(head)
    const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summary?.data.shadowedSeqs).not.toContain(head)
  })

  function imageRecoveryFixture() {
    const ctx = new Context()
    const meter = installTokenMeter(ctx)
    void new SessionStore(ctx)
    installImageOffload(ctx)
    const session = Session.create(SessionId('image-recovery'), undefined, undefined, undefined, [imageOffloadProjection])
    const source = session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'history '.repeat(1000) }, {
        type: 'image', attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
        },
      }],
    }), { surfaceOp: 'append' })
    const agent = { session, options: {} } as Agent
    const failure = new LlmError('image budget exceeded', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 })
    const summarize = vi.fn(async (_input: SummarizationInput) => ({
      summary: [{ type: 'text' as const, text: 'checkpoint' }], provider: 'test', model: 'test',
    })).mockRejectedValueOnce(failure)
    const recover: Parameters<typeof compactSurfaceRegion>[0]['recover'] = (error, owner, sourceEventSeqs, signal) =>
      ctx.waterfall('compaction/summary-error', {
        session: owner.session, sourceEventSeqs, error, ...signal === undefined ? {} : { signal },
      }, () => false)
    return { ctx, meter, session, source, agent, failure, summarize, recover }
  }

  it('retries image-offload recovery with the newly projected input in one transaction', async () => {
    const { session, source, agent, meter, summarize, recover } = imageRecoveryFixture()
    await compactSurfaceRegion({ meter, summarize, recover }, session, source.seq, source.seq, agent,
      { owner: null, stability: 'selected-span' })
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(summarize.mock.calls[0]?.[0].messages[0]?.content[1]).not.toHaveProperty('offloaded')
    expect(summarize.mock.calls[1]?.[0].messages[0]?.content[1]).toMatchObject({ offloaded: true })
    expect(source.data.content[1]).not.toHaveProperty('offloaded')
    expect(session.snapshotEvents().filter(event => event.type === 'image/offload')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('stops a recovery listener claiming success without changing the request', async () => {
    const { session, source, agent, meter, summarize, failure } = imageRecoveryFixture()
    await expect(compactSurfaceRegion({ meter, summarize, recover: () => true }, session,
      source.seq, source.seq, agent, { owner: null, stability: 'selected-span' }))
      .rejects.toMatchObject({ cause: failure })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(0)
  })

  it('stops recovery when projected inputs cycle back to a previously failed request', async () => {
    const { session, source, agent, meter, summarize, failure } = imageRecoveryFixture()
    summarize.mockRejectedValue(failure)
    const originalDerive = session.deriveEventMessage.bind(session)
    let alternate = false
    vi.spyOn(session, 'deriveEventMessage').mockImplementation(event => {
      const message = originalDerive(event)
      return event.seq === source.seq && message !== null && alternate
        ? { ...message, content: [{ type: 'text', text: 'alternate history '.repeat(1000) }] }
        : message
    })
    const recover = vi.fn(() => { alternate = !alternate; return true })
    await expect(compactSurfaceRegion({ meter, summarize, recover }, session,
      source.seq, source.seq, agent, { owner: null, stability: 'selected-span' }))
      .rejects.toMatchObject({ cause: failure })
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledTimes(2)
  })

  it('keeps cancellation authoritative after an image repair and before redispatch', async () => {
    const { session, source, agent, meter, summarize, recover } = imageRecoveryFixture()
    const controller = new AbortController()
    const reason = new Error('cancel image recovery')
    const cancelAfterRecovery: typeof recover = (...args) => {
      const changed = recover(...args)
      controller.abort(reason)
      return changed
    }
    await expect(compactSurfaceRegion({ meter, summarize, recover: cancelAfterRecovery }, session,
      source.seq, source.seq, agent, { owner: null, stability: 'selected-span' }, controller.signal))
      .rejects.toBe(reason)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('prices the system once as fixed overhead and keys capacity by content, not identity', async () => {
    const { ctx, session, meter, agent } = fixture()
    void new LlmRuntime(ctx)
    ctx.llm.registerAdapter(['test'], new ModelAdapter())
    const config = { summarizationProvider: '', summarizationModel: '', maxTokens: 64 }
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'replay' }] })
    const system = createSystemMessage('fixed instructions')
    const estimate = (messages: typeof system[] | (typeof system | typeof user)[]) =>
      estimateDefaultSummaryEnvelope(ctx, meter, config, { messages }, agent)
    const empty = await estimate([])
    const full = await estimate([system, user])
    expect(full.fixedEnvelopeTokens - empty.fixedEnvelopeTokens).toBe(meter.estimateMessage(system))
    expect(full.replayMessageTokens).toBe(meter.estimateMessage(user))
    expect(full.estimatedInputTokens).toBe(full.fixedEnvelopeTokens + full.replayMessageTokens + full.instructionTokens)
    expect((await estimate([createSystemMessage('fixed instructions'), user])).capacityKey).toBe(full.capacityKey)
    expect((await estimate([createSystemMessage('changed instructions'), user])).capacityKey).not.toBe(full.capacityKey)
    expect(session.surface.nodes).toHaveLength(4)
  })
})
