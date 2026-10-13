# DSH 0.2.1-alpha.2 validation

## Upstream finding

The plugin's continuous-convergence defect remains in official alpha.2. The released npm `@deepseek-ai/dsh-compaction-basic@0.2.1-alpha.2`, imported separately from the plugin test alias, was run against the same deterministic Session and fixed summary as this plugin. With `compactionRetries: 0`, official basic commits one shrinking replacement then throws `compaction still above threshold after 1 compaction attempts`, leaving request pressure at or above 300 tokens. Convergent commits more than one replacement and ends below 300 tokens. Both assertions pass in `tests/alpha2-upstream-comparison.spec.ts`. Explicit headroom 0 and summary maxTokens 8192 align official policy with this controlled fixture; no provider request is made.

Official source: https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction-basic/src/index.ts#L330-L346

Official release: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2

The release mentions fixing premature compaction-result display. That is distinct from the successful-chunk cap and is not treated as proof of convergence. This report does not claim that all historical compaction defects remain, or reproduce a particular production Session.

## Compatibility changes

- Exact DSH alpha.2 peer/dev family, Cordis 4.0.5-alpha.1, official registry lockfile.
- Preserve durable system/message heads in every selection path, manual compaction, summary replay, and capacity pricing.
- First-class tool-role results, toolHistory, required assistant stream records, async agent creation, and startSeq/endSeq replacement fields.
- Retain official summary-error/image-offload recovery. No-change or repeated inputs fail finitely; cancellation stops redispatch.
- Honor routed output reservation and optional headroomTokens (default 0), retaining convergent defaults of 8192 summary maxTokens and capped implicit retention.
- Remove the retired runtime-invariants dependency and empty invariant companion. Behavioral transaction, pairing, cancellation, and failure assertions remain.
- Current-format historical repair remains copy-only and requires official migration for older Session generations.

## Checks on Linux / Node 24.19.0

- npm locked dependency resolution without force or legacy-peer-deps: passed.
- npm run typecheck: passed.
- npm run test:coverage: 8 files / 171 tests passed.
- Coverage: statements 90.94%, branches 89.63%, functions 93.38%, lines 92.40%. This is not 100% coverage.
- npm run build: passed.
- Original 153 behavior tests preserved; new tests cover official-vs-plugin comparison, system-head protection, real alpha.2 image-offload projection, recovery failure bounds/cancellation, and pressure reservation.

## Limits

Fixed-input adapters and local Sessions only. No real provider account, production transcript, Windows execution, live deployment, or real-model semantic-quality/latency verification. Published artifacts must be loaded alone as the compaction service provider. Remote push, tag/release, npm publication, merge, and deployment are outside this local validation.
