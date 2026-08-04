/**
 * Resource limits shared by Source post-processing config producers and the
 * persisted-input normalizer. Keeping the cap here prevents workflow modules
 * from constructing a configuration the Source module cannot accept.
 */
export const SOURCE_POST_PROCESSING_LIMITS = {
  candidatePrefilterMax: 100,
  deepAnalysisMaxCandidatesPerRun: 25,
  /** Maximum number of source items sent to one Research structured-output run. */
  researchStructuredOutputBatchSize: 10,
  /** A screening batch must never hold the shared Jobs worker indefinitely. */
  researchStructuredOutputTimeoutMs: 120_000,
  /** User-visible Research recovery takes precedence over background source work. */
  researchRecoveryJobPriority: 50,
  researchRecoveryJobMaxAttempts: 2,
} as const;
