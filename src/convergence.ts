/**
 * Durable diagnostics and reconstruction for one automatic compaction job.
 *
 * The records live as an additive `convergence` field on the already-known
 * `compaction/*` events. They do not affect Session surface reconstruction.
 *
 * @module @zzusp/dsh-compaction-convergent/convergence
 */

import { randomUUID } from 'node:crypto'
import type { CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SummaryEnvelopeEstimate } from './summarizer.ts'

const RECORD_VERSION = 1
const CAPACITY_SAFETY_RATIO = 0.1

/** Learned capacity for one exact default-summary envelope. */
export interface SummaryCapacityProfile {
  readonly capacityKey: string
  readonly largestAcceptedReplayTokens?: number
  readonly smallestRejectedReplayTokens?: number
  readonly acceptedSamples: number
  readonly rejectedSamples: number
  readonly safetyMarginTokens: number
  readonly firstObservedAt: number
  readonly updatedAt: number
}

/** Stable identity and counters carried by every transaction attempt in one job. */
export interface CompactionJobAttempt {
  readonly jobId: string
  readonly trigger: CompactionTrigger
  readonly thresholdTokens?: number
  readonly chunkIndex: number
  readonly attemptIndex: number
  readonly surfaceGenerationBefore: number
  readonly requestTokensBefore: number
  readonly surfaceTokensBefore: number
  readonly range: { readonly start: number; readonly end: number }
  readonly selectedSurfaceTokens: number
  readonly capacityKey?: string
  readonly capacity?: SummaryCapacityProfile
}

/** Additive payload recorded on a `compaction/*` event. */
export interface CompactionConvergenceRecord extends CompactionJobAttempt {
  readonly version: typeof RECORD_VERSION
  readonly outcome: 'started' | 'succeeded' | 'failed'
  readonly willContinueJob: boolean
  readonly state: 'running' | 'completed' | 'failed' | 'one-shot'
  readonly requestTokensAfter?: number
  readonly surfaceTokensAfter?: number
  readonly shadowedTokens?: number
  readonly framedSummaryTokens?: number
  readonly summaryEstimatedInputTokens?: number
  readonly summaryReservedOutputTokens?: number
  readonly providerInputTokens?: number
  readonly providerOutputTokens?: number
  readonly remainingToThreshold?: number
  readonly failureKind?: 'input-too-large' | 'non-shrinking' | 'cancelled' | 'unknown'
  readonly failureMessage?: string
  readonly nextTokenBudget?: number
  readonly nonShrinkingSummaryTokens?: number
  readonly nonShrinkingShadowedTokens?: number
}

/** Mutable counters for the currently executing logical job. */
export interface CompactionJob {
  readonly jobId: string
  readonly trigger: CompactionTrigger
  readonly thresholdTokens?: number
  chunkIndex: number
  attemptIndex: number
}

/** Reconstructed observations required before a job starts or resumes. */
export interface RestoredConvergence {
  readonly job: CompactionJob
  readonly profiles: Map<string, SummaryCapacityProfile>
  readonly records: readonly CompactionConvergenceRecord[]
}

/** Build the opening marker record for one transaction attempt. */
export function startedRecord(attempt: CompactionJobAttempt): CompactionConvergenceRecord {
  return {
    version: RECORD_VERSION,
    ...attempt,
    outcome: 'started',
    willContinueJob: true,
    state: 'running',
  }
}

/** Fold one accepted or rejected replay observation into immutable bounds. */
export function observeCapacity(
  profile: SummaryCapacityProfile | undefined,
  estimate: SummaryEnvelopeEstimate,
  outcome: 'accepted' | 'rejected',
  observedAt: number,
): SummaryCapacityProfile {
  const firstObservedAt = profile?.firstObservedAt ?? observedAt
  const accepted = outcome === 'accepted'
    ? Math.max(profile?.largestAcceptedReplayTokens ?? 0, estimate.replayMessageTokens)
    : profile?.largestAcceptedReplayTokens
  const rejected = outcome === 'rejected'
    ? Math.min(
      profile?.smallestRejectedReplayTokens ?? Number.POSITIVE_INFINITY,
      estimate.replayMessageTokens,
    )
    : profile?.smallestRejectedReplayTokens
  const safetyMarginTokens = accepted === undefined
    ? 0
    : Math.max(1, Math.ceil(accepted * CAPACITY_SAFETY_RATIO))
  return {
    capacityKey: estimate.capacityKey,
    ...(accepted === undefined ? {} : { largestAcceptedReplayTokens: accepted }),
    ...(rejected === undefined ? {} : { smallestRejectedReplayTokens: rejected }),
    acceptedSamples: (profile?.acceptedSamples ?? 0) + (outcome === 'accepted' ? 1 : 0),
    rejectedSamples: (profile?.rejectedSamples ?? 0) + (outcome === 'rejected' ? 1 : 0),
    safetyMarginTokens,
    firstObservedAt,
    updatedAt: observedAt,
  }
}

/** Conservative replay budget learned for a compatible future range. */
export function learnedReplayBudget(profile: SummaryCapacityProfile | undefined): number | undefined {
  if (profile?.largestAcceptedReplayTokens !== undefined) {
    const acceptedBudget = Math.max(
      1,
      profile.largestAcceptedReplayTokens - profile.safetyMarginTokens,
    )
    return profile.smallestRejectedReplayTokens === undefined
      ? acceptedBudget
      : Math.min(acceptedBudget, Math.max(1, profile.smallestRejectedReplayTokens - 1))
  }
  if (profile?.smallestRejectedReplayTokens !== undefined) {
    return Math.max(1, Math.floor(profile.smallestRejectedReplayTokens / 2))
  }
  return undefined
}

/** Read additive convergence data without changing the upstream Session vocabulary. */
export function convergenceRecord(
  event: SessionEvent,
): CompactionConvergenceRecord | undefined {
  const data = event.data as object & { convergence?: unknown }
  const candidate = data.convergence
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const record = candidate as Partial<CompactionConvergenceRecord>
  if (record.version !== RECORD_VERSION
    || typeof record.jobId !== 'string'
    || (record.trigger !== 'pressure' && record.trigger !== 'context-overflow')
    || !Number.isSafeInteger(record.chunkIndex)
    || !Number.isSafeInteger(record.attemptIndex)
    || !isNonNegativeInteger(record.surfaceGenerationBefore)
    || !isNonNegativeInteger(record.requestTokensBefore)
    || !isNonNegativeInteger(record.surfaceTokensBefore)
    || !isNonNegativeInteger(record.selectedSurfaceTokens)
    || !isRange(record.range)
    || typeof record.willContinueJob !== 'boolean'
    || (record.state !== 'running'
      && record.state !== 'completed'
      && record.state !== 'failed'
      && record.state !== 'one-shot')
    || (record.capacity !== undefined && !isCapacityProfile(record.capacity))
    || (record.outcome !== 'started' && record.outcome !== 'succeeded' && record.outcome !== 'failed')) {
    return undefined
  }
  return record as CompactionConvergenceRecord
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRange(value: unknown): value is { readonly start: number; readonly end: number } {
  if (typeof value !== 'object' || value === null) return false
  const range = value as { readonly start?: unknown; readonly end?: unknown }
  return isNonNegativeInteger(range.start) && isNonNegativeInteger(range.end)
}

function isCapacityProfile(value: unknown): value is SummaryCapacityProfile {
  if (typeof value !== 'object' || value === null) return false
  const profile = value as Partial<SummaryCapacityProfile>
  return typeof profile.capacityKey === 'string'
    && isNonNegativeInteger(profile.acceptedSamples)
    && isNonNegativeInteger(profile.rejectedSamples)
    && isNonNegativeInteger(profile.safetyMarginTokens)
    && isNonNegativeInteger(profile.firstObservedAt)
    && isNonNegativeInteger(profile.updatedAt)
    && (profile.largestAcceptedReplayTokens === undefined
      || isNonNegativeInteger(profile.largestAcceptedReplayTokens))
    && (profile.smallestRejectedReplayTokens === undefined
      || isNonNegativeInteger(profile.smallestRejectedReplayTokens))
}

/**
 * Rebuild compatible capacity profiles and resume only the newest unfinished
 * job with the same trigger and threshold contract.
 */
export function restoreConvergence(
  session: Session,
  trigger: CompactionTrigger,
  thresholdTokens: number | undefined,
): RestoredConvergence {
  const profiles = new Map<string, SummaryCapacityProfile>()
  const records: CompactionConvergenceRecord[] = []
  let latest: CompactionConvergenceRecord | undefined
  for (const event of session.events) {
    const record = convergenceRecord(event)
    if (record === undefined) continue
    records.push(record)
    latest = record
    if (record.capacity !== undefined) {
      profiles.set(record.capacity.capacityKey, record.capacity)
    }
  }

  const job: CompactionJob = latest !== undefined
    && latest.trigger === trigger
    && latest.thresholdTokens === thresholdTokens
    && latest.willContinueJob
    && latest.state === 'running'
    ? {
      jobId: latest.jobId,
      trigger,
      ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
      chunkIndex: latest.chunkIndex + (latest.outcome === 'succeeded' ? 1 : 0),
      attemptIndex: latest.attemptIndex + 1,
    }
    : {
      jobId: randomUUID(),
      trigger,
      ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
      chunkIndex: 0,
      attemptIndex: 0,
    }
  return { job, profiles, records }
}

/** Failed ranges in the current generation of the restored logical job. */
export function currentJobFailureRecords(
  restored: RestoredConvergence,
  surfaceGeneration: number,
): readonly CompactionConvergenceRecord[] {
  return restored.records.filter(record => (
    record.jobId === restored.job.jobId
    && record.surfaceGenerationBefore === surfaceGeneration
    && record.outcome === 'failed'
  ))
}
