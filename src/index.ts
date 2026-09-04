/**
 * Basic replay-aware compaction backend.
 *
 * @module @zzusp/dsh-compaction-convergent
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, assertNever, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  oldestCompactableSurfaceUnit,
  selectCompactableRange,
  selectLargestCompactablePrefix,
  selectMaximalCompactableRange,
  SummaryNotSmallerError,
} from './region.ts'
import {
  estimateDefaultSummaryEnvelope,
  summarizeWithLlm,
  SummaryInputTooLargeError,
} from './summarizer.ts'
import type { SummarizationInput, SummaryEnvelopeEstimate, SummaryResult } from './summarizer.ts'
import {
  convergenceRecord,
  currentJobFailureRecords,
  learnedReplayBudget,
  observeCapacity,
  restoreConvergence,
} from './convergence.ts'
import type {
  CompactionJob,
  CompactionJobAttempt,
  RestoredConvergence,
  SummaryCapacityProfile,
} from './convergence.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'
export type { SummaryEnvelopeEstimate } from './summarizer.ts'
export type { CompactionConvergenceRecord, SummaryCapacityProfile } from './convergence.ts'

export { SummaryNotSmallerError } from './region.ts'
export { SummaryInputTooLargeError } from './summarizer.ts'
export { convergenceRecord } from './convergence.ts'

type Range = { readonly start: number; readonly end: number }

type FailedRange =
  | { readonly kind: 'non-shrinking'; readonly error: SummaryNotSmallerError }
  | {
    readonly kind: 'input-too-large'
    readonly error: unknown
    readonly nextTokenBudget: number
    readonly allowClosedStepOrphans: boolean
  }

interface JobExecution {
  readonly job: CompactionJob
  readonly profiles: Map<string, SummaryCapacityProfile>
  capacityKey: string | undefined
}

/** Stable terminal diagnosis when even the oldest balanced surface unit cannot be submitted. */
export class OversizedSurfaceUnitError extends Error {
  readonly code = 'SUMMARY_SURFACE_UNIT_TOO_LARGE'

  constructor(
    readonly unit: { readonly start: number; readonly end: number; readonly tokens: number },
    readonly availableReplayTokens: number | undefined,
    readonly contextWindow: number | undefined,
    readonly fixedEnvelopeTokens: number | undefined,
    readonly instructionTokens: number | undefined,
    readonly reservedOutputTokens: number | undefined,
    options?: ErrorOptions,
  ) {
    const budget = availableReplayTokens === undefined
      ? 'after the provider rejected that unit as context overflow'
      : `because it exceeds replay budget ${availableReplayTokens}`
    const capacity = contextWindow === undefined
      ? ''
      : ` within context window ${contextWindow}`
    const envelope = fixedEnvelopeTokens === undefined
      || instructionTokens === undefined
      || reservedOutputTokens === undefined
      ? ''
      : ` after fixed envelope ${fixedEnvelopeTokens}, instruction ${instructionTokens}, `
        + `and output reserve ${reservedOutputTokens}`
    super(
      `summarization cannot fit the oldest indivisible surface unit `
      + `(seqs ${unit.start}-${unit.end}, ~${unit.tokens} message tokens) ${budget}${capacity}${envelope}`,
      options,
    )
    this.name = 'OversizedSurfaceUnitError'
  }
}

/** Increasingly aggressive retained-tail budgets for one shrinking attempt. */
function expansionBudgets(retainTokens: number): readonly number[] {
  return [...new Set([retainTokens, Math.floor(retainTokens / 2), 0])]
}

/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  /** Non-shrinking and provider-rejected ranges stay suppressed until the surface advances. */
  private readonly failedRanges = new WeakMap<Session, {
    readonly generation: number
    readonly ranges: Map<string, FailedRange>
  }>()

  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly historicalRepairSessions = new WeakSet<Session>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    if (this.historicalRepairSessions.has(agent.session)) {
      return this.summarizeHistorical(input, agent, config, signal)
    }
    return summarizeWithLlm(this.ctx, this.ctx.tokenMeter, config, input, agent, signal)
  }

  /** Reduce an oversized historical surface through balanced chronological chunks. */
  private async summarizeHistorical(
    input: SummarizationInput,
    agent: Agent,
    config: ResolvedConfig | ReturnType<typeof resolveTargetPolicy>,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const chunks: Array<typeof input.messages> = []
    let chunk: typeof input.messages = []
    let characters = 0
    const pending = new Set<string>()
    for (const message of input.messages) {
      chunk = [...chunk, message]
      characters += JSON.stringify(message).length
      for (const block of message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
        if (block.type === 'tool-result') pending.delete(block.toolCallId)
      }
      if (characters >= 180_000 && pending.size === 0) {
        chunks.push(chunk)
        chunk = []
        characters = 0
      }
    }
    if (chunk.length > 0) chunks.push(chunk)
    if (chunks.length <= 1) {
      return summarizeWithLlm(this.ctx, this.ctx.tokenMeter, config, input, agent, signal)
    }

    let summaries: SummaryResult[] = []
    for (const messages of chunks) {
      summaries.push(await summarizeWithLlm(
        this.ctx,
        this.ctx.tokenMeter,
        config,
        { messages },
        agent,
        signal,
      ))
    }
    while (summaries.length > 1) {
      const next: SummaryResult[] = []
      for (let index = 0; index < summaries.length; index += 8) {
        const group = summaries.slice(index, index + 8)
        next.push(await summarizeWithLlm(this.ctx, this.ctx.tokenMeter, config, {
          messages: group.map((summary, part) => createUserMessage({
            content: [{
              type: 'text',
              text: `Chronological partial checkpoint ${index + part + 1}:\n${summary.summary
                .filter(block => block.type === 'text')
                .map(block => block.text)
                .join('\n')}`,
            }],
            source: { kind: 'plugin', plugin: 'dsh-compaction-convergent-repair' },
          })),
        }, agent, signal))
      }
      summaries = next
    }
    return summaries[0]!
  }

  /** Return the generation-scoped range failure cache for one live surface. */
  private rangeFailures(session: Session): Map<string, FailedRange> {
    const generation = session.surface.replaceGeneration
    const cached = this.failedRanges.get(session)
    if (cached?.generation === generation) return cached.ranges
    const ranges = new Map<string, FailedRange>()
    this.failedRanges.set(session, { generation, ranges })
    return ranges
  }

  /** Add durable failures from a resumed job to the generation-local suppression map. */
  private restoreFailedRanges(
    session: Session,
    restored: RestoredConvergence,
  ): Map<string, FailedRange> {
    const failed = this.rangeFailures(session)
    for (const record of currentJobFailureRecords(
      restored,
      session.surface.replaceGeneration,
    )) {
      const rangeKey = `${record.range.start}:${record.range.end}`
      if (failed.has(rangeKey)) continue
      if (record.failureKind === 'non-shrinking'
        && record.nonShrinkingSummaryTokens !== undefined
        && record.nonShrinkingShadowedTokens !== undefined) {
        failed.set(rangeKey, {
          kind: 'non-shrinking',
          error: new SummaryNotSmallerError(
            record.nonShrinkingSummaryTokens,
            record.nonShrinkingShadowedTokens,
          ),
        })
      } else if (record.failureKind === 'input-too-large') {
        failed.set(rangeKey, {
          kind: 'input-too-large',
          error: Object.assign(
            new Error(record.failureMessage ?? 'restored summary input overflow'),
            { code: CONTEXT_WINDOW_EXCEEDED_CODE },
          ),
          nextTokenBudget: record.nextTokenBudget
            ?? learnedReplayBudget(record.capacity)
            ?? Math.max(1, Math.floor(record.selectedSurfaceTokens / 2)),
          allowClosedStepOrphans: false,
        })
      }
    }
    return failed
  }

  /** Price the current default-summary fixed envelope without dispatching. */
  private async defaultEnvelopeHint(
    agent: Agent,
    policy: ResolvedConfig | ReturnType<typeof resolveTargetPolicy>,
    signal: AbortSignal,
  ): Promise<SummaryEnvelopeEstimate | undefined> {
    if (this.summarize !== BasicCompactionEngine.prototype.summarize) return undefined
    const header = agent.session.requestHeader()
    return estimateDefaultSummaryEnvelope(
      this.ctx,
      this.ctx.tokenMeter,
      policy,
      {
        ...header?.system === undefined ? {} : { system: header.system },
        ...header?.tools === undefined ? {} : { tools: header.tools },
        messages: [],
      },
      agent,
      signal,
    )
  }

  /**
   * Compact one policy-selected range, shrinking only after a typed summary
   * context overflow. Preflight failures use their exact replay budget;
   * provider rejections halve the prior range because tokenizer drift is not
   * observable through the heuristic meter.
   */
  private async compactWithCapacityFallback(
    initialRange: Range,
    initialMeasurement: TokenMeasurement,
    agent: Agent,
    signal: AbortSignal,
    attemptedRanges: Set<string>,
    failedRanges: Map<string, FailedRange>,
    execution: JobExecution,
    allowClosedStepOrphans = false,
  ): Promise<CompactionResult> {
    let range = initialRange
    let measurement = initialMeasurement
    let allowOrphans = allowClosedStepOrphans

    while (true) {
      const rangeKey = `${range.start}:${range.end}`
      const cached = failedRanges.get(rangeKey)
      if (cached?.kind === 'non-shrinking') throw cached.error
      if (cached?.kind === 'input-too-large') {
        const smaller = this.smallerRange(
          agent.session,
          measurement,
          range,
          cached.nextTokenBudget,
        )
        if (smaller === null) {
          throw this.oversizedUnitError(
            agent.session,
            measurement,
            cached.error,
            cached.allowClosedStepOrphans,
          )
        }
        range = smaller
        allowOrphans = false
        continue
      }
      if (attemptedRanges.has(rangeKey)) {
        throw new Error(`compaction: range ${rangeKey} was selected twice without a recorded failure`)
      }
      attemptedRanges.add(rangeKey)

      const profile = execution.capacityKey === undefined
        ? undefined
        : execution.profiles.get(execution.capacityKey)
      const jobAttempt: CompactionJobAttempt = {
        jobId: execution.job.jobId,
        trigger: execution.job.trigger,
        ...(execution.job.thresholdTokens === undefined
          ? {}
          : { thresholdTokens: execution.job.thresholdTokens }),
        chunkIndex: execution.job.chunkIndex,
        attemptIndex: execution.job.attemptIndex,
        surfaceGenerationBefore: agent.session.surface.replaceGeneration,
        requestTokensBefore: measurement.totalTokens,
        surfaceTokensBefore: measurement.surfaceTokens,
        range,
        selectedSurfaceTokens: this.rangeTokens(measurement, range),
        ...(execution.capacityKey === undefined ? {} : { capacityKey: execution.capacityKey }),
        ...(profile === undefined ? {} : { capacity: profile }),
      }

      try {
        const result = await this.compactRegion(
          range.start,
          range.end,
          agent,
          signal,
          allowOrphans,
          jobAttempt,
        )
        execution.job.attemptIndex += 1
        const event = agent.session.events[result.summarySeq]
        const record = event === undefined ? undefined : convergenceRecord(event)
        if (record?.capacity !== undefined) {
          execution.capacityKey = record.capacity.capacityKey
          execution.profiles.set(record.capacity.capacityKey, record.capacity)
        }
        return result
      } catch (error: unknown) {
        execution.job.attemptIndex += 1
        if (error instanceof SummaryNotSmallerError) {
          failedRanges.set(rangeKey, { kind: 'non-shrinking', error })
          throw error
        }
        if (!this.isSummaryContextOverflow(error)) throw error

        if (error instanceof SummaryInputTooLargeError) {
          execution.capacityKey = error.estimate.capacityKey
          const learned = observeCapacity(
            execution.profiles.get(error.estimate.capacityKey),
            error.estimate,
            'rejected',
            Date.now(),
          )
          execution.profiles.set(error.estimate.capacityKey, learned)
        }

        measurement = this.ctx.tokenMeter.measure(agent.session)
        const selectedTokens = this.rangeTokens(measurement, range)
        const nextTokenBudget = this.nextTokenBudget(selectedTokens, error)
        failedRanges.set(rangeKey, {
          kind: 'input-too-large',
          error,
          nextTokenBudget,
          allowClosedStepOrphans: allowOrphans,
        })
        const smaller = this.smallerRange(
          agent.session,
          measurement,
          range,
          nextTokenBudget,
        )
        if (smaller === null) {
          throw this.oversizedUnitError(
            agent.session,
            measurement,
            error,
            allowOrphans,
          )
        }
        range = smaller
        allowOrphans = false
      }
    }
  }

  /** Apply a compatible learned replay cap without expanding the policy range. */
  private capacityBoundedRange(
    session: Session,
    measurement: TokenMeasurement,
    range: Range,
    execution: JobExecution,
  ): Range | null {
    const budget = execution.capacityKey === undefined
      ? undefined
      : learnedReplayBudget(execution.profiles.get(execution.capacityKey))
    if (budget === undefined || this.rangeTokens(measurement, range) <= budget) return range
    return selectLargestCompactablePrefix(session, measurement, range.end, budget)
  }

  /** Select a strictly smaller balanced prefix under one message-token cap. */
  private smallerRange(
    session: Session,
    measurement: TokenMeasurement,
    range: Range,
    maxTokens: number,
  ): Range | null {
    const endIdx = measurement.nodes.findIndex(node => node.seq === range.end)
    if (endIdx <= 0) return null
    return selectLargestCompactablePrefix(
      session,
      measurement,
      measurement.nodes[endIdx - 1]!.seq,
      maxTokens,
    )
  }

  /** Read the heuristic token count for one current positional range. */
  private rangeTokens(measurement: TokenMeasurement, range: Range): number {
    const startIdx = measurement.nodes.findIndex(node => node.seq === range.start)
    const endIdx = measurement.nodes.findIndex(node => node.seq === range.end)
    if (startIdx === -1 || endIdx < startIdx) {
      throw new Error(`compaction: selected range ${range.start}:${range.end} is absent from token measurement`)
    }
    return measurement.nodes
      .slice(startIdx, endIdx + 1)
      .reduce((total, node) => total + node.tokens, 0)
  }

  /** Derive the next strict range budget from preflight facts or provider feedback. */
  private nextTokenBudget(selectedTokens: number, error: unknown): number {
    if (error instanceof SummaryInputTooLargeError) {
      const replayBudget = error.providerRejected
        ? error.providerReplayTokenLimit
        : error.estimate.availableReplayTokens
      if (replayBudget === undefined) {
        return Math.min(selectedTokens - 1, Math.floor(selectedTokens / 2))
      }
      if (error.estimate.replayMessageTokens === 0) return -1
      return Math.min(
        selectedTokens - 1,
        Math.floor(
          selectedTokens
          * replayBudget
          / error.estimate.replayMessageTokens,
        ),
      )
    }
    return Math.min(selectedTokens - 1, Math.floor(selectedTokens / 2))
  }

  /** Route only canonical summary context failures into range reduction. */
  private isSummaryContextOverflow(error: unknown): boolean {
    return error instanceof SummaryInputTooLargeError
      || (typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === CONTEXT_WINDOW_EXCEEDED_CODE)
  }

  /** Build the finite terminal error for an oversized oldest balanced unit. */
  private oversizedUnitError(
    session: Session,
    measurement: TokenMeasurement,
    cause: unknown,
    allowClosedStepOrphans: boolean,
  ): OversizedSurfaceUnitError {
    const unit = oldestCompactableSurfaceUnit(session, measurement, allowClosedStepOrphans)
      ?? (() => {
        const first = measurement.nodes[0]
        if (first === undefined) {
          throw new Error('compaction: oversized-unit diagnosis has no surface node')
        }
        return { start: first.seq, end: first.seq, tokens: first.tokens }
      })()
    const estimate = cause instanceof SummaryInputTooLargeError ? cause.estimate : undefined
    return new OversizedSurfaceUnitError(
      unit,
      cause instanceof SummaryInputTooLargeError && cause.providerRejected
        ? undefined
        : estimate?.availableReplayTokens,
      estimate?.contextWindow,
      estimate?.fixedEnvelopeTokens,
      estimate?.instructionTokens,
      estimate?.reservedOutputTokens,
      { cause },
    )
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-convergent remains independently composable.
    // Overflow always executes at least one useful chunk; when route capacity is
    // known, both triggers share the same below-threshold completion condition.
    const prune = this.ctx.get('toolResultPruner')
    let context: Awaited<ReturnType<typeof this.ctx.llm.resolveModelInfo>>['context']
    try {
      context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    } catch (error: unknown) {
      if (trigger === 'pressure') throw error
      context = undefined
    }
    assertNoActiveCompaction(agent.session, 'automatic compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined && trigger === 'pressure') {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-convergent: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    let spec: ReturnType<typeof resolveCompactSpec> | undefined
    if (context !== undefined) {
      try {
        spec = resolveCompactSpec(policy, context.contextWindow)
      } catch (error: unknown) {
        if (trigger === 'pressure') throw error
        spec = undefined
      }
    }
    if (trigger === 'pressure'
      && spec !== undefined
      && measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (trigger === 'pressure'
      && spec !== undefined
      && measurement.totalTokens < spec.thresholdTokens) return null

    const thresholdTokens = spec?.thresholdTokens
    const restored = restoreConvergence(agent.session, trigger, thresholdTokens)
    const hint = await this.defaultEnvelopeHint(agent, policy, signal)
    const latestJobRecord = restored.records.findLast(record => record.jobId === restored.job.jobId)
    const execution: JobExecution = {
      job: restored.job,
      profiles: restored.profiles,
      capacityKey: hint?.capacityKey ?? latestJobRecord?.capacityKey,
    }
    let result: CompactionResult | null = null
    const attemptedRanges = new Set<string>()
    let failedRanges = this.restoreFailedRanges(agent.session, restored)
    let forceOverflowChunk = trigger === 'context-overflow'
    while (forceOverflowChunk
      || (thresholdTokens !== undefined && measurement.totalTokens >= thresholdTokens)) {
      signal.throwIfAborted()
      const generationBefore = agent.session.surface.replaceGeneration
      const tokensBefore = measurement.totalTokens
      let compacted = false
      let nonShrinking: SummaryNotSmallerError | undefined
      const budgets = forceOverflowChunk
        ? [0]
        : expansionBudgets(spec?.retainTokens ?? 0)
      for (const [budgetIndex, retainTokens] of budgets.entries()) {
        if (budgetIndex > 0) measurement = meter.measure(agent.session)
        const selected = selectCompactableRange(agent.session, measurement, retainTokens)
        if (selected === null) continue
        const range = this.capacityBoundedRange(
          agent.session,
          measurement,
          selected,
          execution,
        ) ?? selected

        try {
          result = await this.compactWithCapacityFallback(
            range,
            measurement,
            agent,
            signal,
            attemptedRanges,
            failedRanges,
            execution,
          )
          compacted = true
          break
        } catch (error: unknown) {
          if (!(error instanceof SummaryNotSmallerError)) throw error
          nonShrinking = error
        }
      }

      if (!compacted && nonShrinking !== undefined) {
        measurement = meter.measure(agent.session)
        const range = selectMaximalCompactableRange(agent.session, measurement)
        if (range !== null) {
          const startIdx = measurement.nodes.findIndex(node => node.seq === range.start)
          const endIdx = measurement.nodes.findIndex(node => node.seq === range.end)
          const selectedTokens = measurement.nodes
            .slice(startIdx, endIdx + 1)
            .reduce((total, node) => total + node.tokens, 0)
          if (thresholdTokens === undefined
            || measurement.totalTokens - selectedTokens < thresholdTokens) {
            const bounded = this.capacityBoundedRange(
              agent.session,
              measurement,
              range,
              execution,
            ) ?? range
            try {
              result = await this.compactWithCapacityFallback(
                bounded,
                measurement,
                agent,
                signal,
                attemptedRanges,
                failedRanges,
                execution,
                true,
              )
              compacted = true
            } catch (error: unknown) {
              if (!(error instanceof SummaryNotSmallerError)) throw error
              nonShrinking = error
            }
          }
        }
      }

      if (!compacted) {
        if (nonShrinking !== undefined) {
          throw new Error('compaction cannot find a shrinking balanced range', {
            cause: nonShrinking,
          })
        }
        if (result === null) return null
        throw new Error(
          `compaction job ${execution.job.jobId} cannot select another shrinking balanced range `
          + `while ${measurement.totalTokens} estimated tokens remain above threshold ${String(thresholdTokens)}`,
        )
      }

      measurement = meter.measure(agent.session)
      if (agent.session.surface.replaceGeneration <= generationBefore) {
        throw new Error(
          `compaction job ${execution.job.jobId} committed no replacement generation progress`,
        )
      }
      if (measurement.totalTokens >= tokensBefore) {
        throw new Error(
          `compaction job ${execution.job.jobId} made no token progress `
          + `(${measurement.totalTokens} after >= ${tokensBefore} before)`,
        )
      }
      execution.job.chunkIndex += 1
      forceOverflowChunk = false
      if (thresholdTokens === undefined || measurement.totalTokens < thresholdTokens) return result
      attemptedRanges.clear()
      failedRanges = this.rangeFailures(agent.session)
    }
    return result
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
    allowClosedStepOrphans = false,
    jobAttempt?: CompactionJobAttempt,
  ): Promise<CompactionResult> {
    const sessions = this.ctx.get('sessions')
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        ...(allowClosedStepOrphans ? { allowClosedStepOrphans: true } : {}),
        ...(jobAttempt === undefined ? {} : {
          jobAttempt,
          ...(sessions === undefined ? {} : {
            flush: async () => { await sessions.flush(agent.session) },
          }),
        }),
      },
      signal,
    )
  }

  /**
   * Force the largest valid historical surface range for an explicit offline
   * repair. This bypasses only automatic pressure policy; the normal summary,
   * shrink, stability, transaction, and closed-step orphan checks still apply.
   * @param agent - detached pre-recovery Session and its durable route.
   * @param signal - cancellation forwarded to the real summarization provider.
   * @returns the committed maximal-range replacement, or `null` for an empty surface.
   */
  async compactHistoricalSurface(
    agent: Agent,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    assertNoActiveCompaction(agent.session, 'historical Session repair')
    const range = selectMaximalCompactableRange(
      agent.session,
      this.ctx.tokenMeter.measure(agent.session),
    )
    if (range === null) return null
    this.historicalRepairSessions.add(agent.session)
    try {
      return await this.compactRegion(range.start, range.end, agent, signal, true)
    } finally {
      this.historicalRepairSessions.delete(agent.session)
    }
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }
}

export default BasicCompactionEngine
