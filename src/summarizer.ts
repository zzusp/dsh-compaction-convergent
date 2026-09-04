/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @zzusp/dsh-compaction-convergent/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  BlockAssembler,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Complete request-budget facts for one default summarization call. */
export interface SummaryEnvelopeEstimate {
  readonly provider: string
  readonly model: string
  readonly contextWindow: number | undefined
  readonly replayMessageTokens: number
  readonly fixedEnvelopeTokens: number
  readonly instructionTokens: number
  readonly estimatedInputTokens: number
  readonly reservedOutputTokens: number
  readonly availableReplayTokens: number | undefined
}

/** A summary range that cannot be submitted to its resolved model as one request. */
export class SummaryInputTooLargeError extends LlmError {
  constructor(
    readonly estimate: SummaryEnvelopeEstimate,
    readonly providerRejected: boolean,
    options?: ErrorOptions,
  ) {
    const capacity = estimate.contextWindow === undefined
      ? 'unknown context capacity'
      : `context window ${estimate.contextWindow}`
    const disposition = providerRejected
      ? 'provider rejected the request as context overflow'
      : 'preflight rejected the request before model dispatch'
    super(
      `summarization input is too large for ${estimate.provider}/${estimate.model}: ${disposition} `
      + `(estimated input ${estimate.estimatedInputTokens} + output reserve ${estimate.reservedOutputTokens}; `
      + `${capacity}; replay messages ${estimate.replayMessageTokens}, fixed envelope `
      + `${estimate.fixedEnvelopeTokens}, instruction ${estimate.instructionTokens})`,
      CONTEXT_WINDOW_EXCEEDED_CODE,
      options,
    )
  }
}

/** Build the exact trailing instruction message shared by estimation and dispatch. */
function compactionInstructionMessage(): Message {
  return createUserMessage({
    content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    source: { kind: 'plugin', plugin: 'dsh-compaction-convergent' },
  })
}

/** Price the full default summary request, including its non-message envelope and output reserve. */
function estimateSummaryEnvelope(
  meter: TokenMeter,
  input: SummarizationInput,
  agent: Agent,
  provider: string,
  model: string,
  maxTokens: number,
  instruction: Message,
  contextWindow: number | undefined,
): SummaryEnvelopeEstimate {
  const envelope = meter.measure(agent.session, {
    config: { provider, model, maxTokens },
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
  })
  const fixedEnvelopeTokens = Math.max(0, envelope.totalTokens - envelope.surfaceTokens)
  const replayMessageTokens = input.messages.reduce(
    (total, message) => total + meter.estimateMessage(message),
    0,
  )
  const instructionTokens = meter.estimateMessage(instruction)
  const estimatedInputTokens = fixedEnvelopeTokens + replayMessageTokens + instructionTokens
  return {
    provider,
    model,
    contextWindow,
    replayMessageTokens,
    fixedEnvelopeTokens,
    instructionTokens,
    estimatedInputTokens,
    reservedOutputTokens: maxTokens,
    availableReplayTokens: contextWindow === undefined
      ? undefined
      : Math.max(0, contextWindow - fixedEnvelopeTokens - instructionTokens - maxTokens),
  }
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param meter - singleton replay-aware meter used for the complete request preflight.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  meter: TokenMeter,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const instruction = compactionInstructionMessage()
  const messages: Message[] = [
    ...input.messages,
    instruction,
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  const modelInfo = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const estimate = estimateSummaryEnvelope(
    meter,
    input,
    agent,
    target.provider,
    target.model,
    config.maxTokens,
    instruction,
    modelInfo.context?.contextWindow,
  )
  if (estimate.contextWindow !== undefined
    && estimate.estimatedInputTokens + estimate.reservedOutputTokens > estimate.contextWindow) {
    throw new SummaryInputTooLargeError(estimate, false)
  }

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) {
    if ((error as Error & { code?: string }).code === CONTEXT_WINDOW_EXCEEDED_CODE) {
      throw new SummaryInputTooLargeError(estimate, true, { cause: error })
    }
    throw error
  }

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
