/** Stable pipeline stage tags, including historical runs.capability_id values. Not Skill or Tool registrations. */
export const RESEARCH_STAGES = Object.freeze({
  source_collect: "research.source_collect",
  source_summarize: "research.source_summarize",
  evidence_extract: "research.evidence_extract",
  brief_synthesize: "research.brief_synthesize",
  idea_generate: "research.idea_generate",
  adhoc_analyze: "research.adhoc_analyze",
  ask: "research.ask",
  monitor_compare: "research.monitor_compare",
} as const);
