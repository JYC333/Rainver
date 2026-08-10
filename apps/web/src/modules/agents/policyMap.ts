/**
 * Translate an AgentVersion / template-version policy + config JSON into the
 * product-level cards the Agent configuration UI renders. This is the single
 * source of truth for "what the agent reads / can create / cannot do", so the
 * tabs never show raw JSON by default.
 *
 * It reads the same fields the backend copies verbatim from a template version
 * into an AgentVersion:
 *   - context_policy_json.allowed_input_contexts / default_input_contexts
 *   - output_policy_json.allowed_output_types / default_review_mode / proposal_only
 *   - memory_policy_json, tool_policy_json, schedule_*_json, model_config_json
 *
 * The model selects which output(s) to emit inside the allowed set at run time
 * (classification_mode: model_selects); durable changes are proposal-only.
 */

type Json = Record<string, unknown>

function asObj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}
function asArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map(String) : []
}
function asBool(v: unknown): boolean {
  return v === true
}

/** Turn a snake_case context/output id into a readable label as a fallback. */
function humanize(id: string): string {
  return id.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

export interface PolicyCard {
  key: string
  label: string
  enabled: boolean
  detail?: string
}

export type OutputMode = 'review' | 'artifact' | 'auto'

export interface OutputCard extends PolicyCard {
  /** review = proposal/draft requiring human approval; artifact = saved output; auto = direct (e.g. chat). */
  mode: OutputMode
  /** memory outputs are always proposal-only and can never be auto-saved. */
  alwaysReview: boolean
}

export interface SafetySummary {
  can: string[]
  cannot: string[]
  /** derived review posture; hard policy defaults are read-only. */
  posture: 'Strict' | 'Balanced' | 'Draft-friendly'
}

export interface ScheduleSummary {
  kind: 'manual' | 'daily' | 'interval' | 'cron'
  label: string
  enabled: boolean
  cron?: string
  timezone?: string
  manualRunAllowed: boolean
}

// ── Input contexts ────────────────────────────────────────────────────────────

const INPUT_CONTEXT_LABELS: Record<string, string> = {
  approved_memory: 'Approved memory',
  existing_approved_memory: 'Approved memory',
  knowledge_items: 'Knowledge items',
  existing_related_knowledge_items: 'Related knowledge items',
  object_relations: 'Object relations',
  sources: 'Sources',
  selected_sources: 'Selected sources',
  source_metadata: 'Source metadata',
  extracted_text: 'Extracted text',
  recent_activities: 'Recent activities',
  unprocessed_activity_records: 'Unprocessed captures / activity',
  activity_records: 'Activity records',
  selected_activities: 'Selected activities',
  selected_conversations: 'Selected conversations',
  previous_reflection_summaries: 'Previous reflection summaries',
  relevant_reflection_summaries: 'Relevant reflection summaries',
  existing_tasks: 'Existing tasks',
  tasks: 'Tasks',
  existing_ideas: 'Existing ideas',
  ideas: 'Ideas',
  projects: 'Projects (current project if selected)',
  project_folder_metadata: 'Project Folder metadata',
  recent_runs: 'Recent runs',
  recent_proposals: 'Recent proposals',
  selected_project_folder: 'Selected Project Folder',
  selected_files: 'Selected files',
  git_diff: 'Git diff',
  agent_docs: 'Agent docs',
  architecture_docs: 'Architecture docs',
  recent_run_artifacts: 'Recent run artifacts',
}

export function inputContextLabel(id: string): string {
  return INPUT_CONTEXT_LABELS[id] ?? humanize(id)
}

export function allowedInputContexts(version: { context_policy_json?: unknown }): string[] {
  return asArr(asObj(version.context_policy_json).allowed_input_contexts)
}

export function defaultInputContexts(version: { context_policy_json?: unknown }): string[] {
  return asArr(asObj(version.context_policy_json).default_input_contexts)
}

/** One card per allowed input context, enabled when it is in the default set. */
export function inputCards(version: { context_policy_json?: unknown }): PolicyCard[] {
  const allowed = allowedInputContexts(version)
  const enabled = new Set(defaultInputContexts(version))
  return allowed.map(id => ({
    key: id,
    label: inputContextLabel(id),
    enabled: enabled.has(id),
  }))
}

/** Rebuild context_policy_json from chosen default contexts; the allowed ceiling is preserved. */
export function buildContextPolicy(base: Record<string, unknown>, enabled: string[]): Record<string, unknown> {
  const allowed = asArr(base.allowed_input_contexts)
  const clamped = enabled.filter(id => allowed.includes(id))
  return { ...base, default_input_contexts: clamped }
}

// ── Output types ──────────────────────────────────────────────────────────────

const OUTPUT_TYPE_LABELS: Record<string, string> = {
  chat_message: 'Chat reply',
  task_create_proposal: 'Task proposals',
  follow_up_task: 'Follow-up tasks',
  // Current registered proposal types
  memory_create: 'Memory',
  memory_update: 'Memory update',
  memory_archive: 'Memory archive',
  knowledge_create: 'Knowledge item',
  knowledge_update: 'Knowledge item update',
  knowledge_archive: 'Knowledge item archive',
  claim_create: 'Claim',
  claim_update: 'Claim update',
  claim_archive: 'Claim archive',
  object_relation_create: 'Object relation',
  object_relation_delete: 'Object relation removal',
  object_profile_create: 'Object profile',
  object_profile_update: 'Object profile update',
  // Legacy labels kept for backward compat with older stored agent versions
  memory_update_proposal: 'Memory update',
  knowledge_item_proposal: 'Knowledge item',
  knowledge_item_create_proposal: 'Knowledge item',
  knowledge_item_update_proposal: 'Knowledge item update',
  knowledge_item_relation_create_proposal: 'Object relation',
  // Artifacts and non-proposal outputs
  reflection_summary_artifact: 'Reflection summary',
  source_summary_artifact: 'Source summary',
  review_report_artifact: 'Review report',
  architecture_risk_summary: 'Architecture risk summary',
  code_change_suggestion: 'Code-change suggestions',
  archive_suggestion: 'Archive suggestions',
  noop: 'No action',
}

export function outputTypeLabel(id: string): string {
  return OUTPUT_TYPE_LABELS[id] ?? humanize(id)
}

export function isMemoryOutput(id: string): boolean {
  return id.startsWith('memory_')
}

export function allowedOutputTypes(version: { output_policy_json?: unknown }): string[] {
  return asArr(asObj(version.output_policy_json).allowed_output_types)
}

/** Review mode for an output type: explicit default_review_mode wins, else heuristic. */
export function reviewModeForType(version: { output_policy_json?: unknown }, id: string): OutputMode {
  const out = asObj(version.output_policy_json)
  const map = asObj(out.default_review_mode)
  const explicit = map[id]
  if (explicit === 'review' || explicit === 'artifact' || explicit === 'auto') return explicit
  if (id === 'chat_message' || id === 'noop') return 'auto'
  if (isMemoryOutput(id)) return 'review'
  if (id.endsWith('_artifact') || id.endsWith('_summary')) return 'artifact'
  return 'review'
}

/** One card per allowed output type, with its review mode. */
export function outputCards(version: { output_policy_json?: unknown }): OutputCard[] {
  return allowedOutputTypes(version).map(id => ({
    key: id,
    label: outputTypeLabel(id),
    enabled: true,
    mode: reviewModeForType(version, id),
    alwaysReview: isMemoryOutput(id),
  }))
}

export const OUTPUT_MODE_LABEL: Record<OutputMode, string> = {
  review: 'Review required',
  artifact: 'Saved as artifact',
  auto: 'Auto',
}

/** Rebuild output_policy_json from chosen output types; can only narrow the ceiling. */
export function buildOutputPolicy(base: Record<string, unknown>, enabled: string[]): Record<string, unknown> {
  const ceiling = asArr(base.allowed_output_types)
  const clamped = enabled.filter(id => ceiling.includes(id))
  return { ...base, allowed_output_types: clamped }
}

// ── Review & safety ─────────────────────────────────────────────────────────

export function safetySummary(version: {
  context_policy_json?: unknown
  memory_policy_json?: unknown
  output_policy_json?: unknown
  tool_policy_json?: unknown
}): SafetySummary {
  const mem = asObj(version.memory_policy_json)
  const out = asObj(version.output_policy_json)
  const tool = asObj(version.tool_policy_json)

  const inputs = inputCards(version).filter(c => c.enabled).map(c => c.label.toLowerCase())
  const outs = outputCards(version).map(c => c.label.toLowerCase())

  const can: string[] = []
  if (inputs.length) can.push(`read ${inputs.join(', ')}`)
  if (outs.length) can.push(`create ${outs.join(', ')}`)

  const writable = asArr(mem.writable_scopes)
  const cannot: string[] = []
  if (writable.length === 0 || asBool(mem.requires_proposal)) cannot.push('directly write memory (proposal-only)')
  if (!asBool(tool.shell)) cannot.push('access the shell')
  if (!asBool(tool.file_write)) cannot.push('write files')
  if (!asBool(tool.project_folder_write)) cannot.push('write Project Folder files')
  if ('web_search' in tool && !asBool(tool.web_search)) cannot.push('search the web')
  if ('patch_apply' in tool && !asBool(tool.patch_apply)) cannot.push('apply code patches')
  if (!asBool(tool.credential_access)) cannot.push('access credentials')

  const proposalOnly = asBool(out.proposal_only)
  const hasArtifact = outputCards(version).some(c => c.mode === 'artifact')
  let posture: SafetySummary['posture']
  if (proposalOnly && (writable.length === 0 || asBool(mem.requires_proposal))) {
    posture = hasArtifact ? 'Balanced' : 'Strict'
  } else {
    posture = 'Draft-friendly'
  }
  return { can, cannot, posture }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export function scheduleSummary(version: { schedule_config_json?: unknown; schedule_defaults_json?: unknown }): ScheduleSummary {
  const sched = asObj(version.schedule_config_json ?? version.schedule_defaults_json)
  const cron = typeof sched.cron === 'string' ? sched.cron : undefined
  const timezone = typeof sched.timezone === 'string' ? sched.timezone : undefined
  const enabled = asBool(sched.enabled)
  const manualRunAllowed = sched.manual_run_allowed !== false
  const everyHours = sched.every_hours ?? sched.interval_hours

  if (everyHours != null) {
    return { kind: 'interval', label: `Every ${String(everyHours)} hours`, enabled, timezone, manualRunAllowed }
  }
  if (cron) {
    const daily = /^0 (\d{1,2}) \* \* \*$/.exec(cron)
    if (daily) {
      const hh = daily[1].padStart(2, '0')
      return { kind: 'daily', label: `Daily at ${hh}:00`, enabled, cron, timezone, manualRunAllowed }
    }
    const interval = /^0 \*\/(\d{1,2}) \* \* \*$/.exec(cron)
    if (interval) {
      return { kind: 'interval', label: `Every ${interval[1]} hours`, enabled, cron, timezone, manualRunAllowed }
    }
    return { kind: 'cron', label: `Custom schedule (${cron})`, enabled, cron, timezone, manualRunAllowed }
  }
  return { kind: 'manual', label: 'Manual only', enabled: false, manualRunAllowed }
}

// ── Model ─────────────────────────────────────────────────────────────────────

export interface ModelFields {
  model?: string
  temperature?: number
  max_tokens?: number
  reasoning_effort?: string
  fallback?: string
}

export function modelFields(version: { model_config_json?: unknown }): ModelFields {
  const m = asObj(version.model_config_json)
  return {
    model: typeof m.model === 'string' ? m.model : undefined,
    temperature: typeof m.temperature === 'number' ? m.temperature : undefined,
    max_tokens: typeof m.max_tokens === 'number' ? m.max_tokens : undefined,
    reasoning_effort: typeof m.reasoning_effort === 'string' ? m.reasoning_effort : undefined,
    fallback: typeof m.fallback === 'string' ? m.fallback : undefined,
  }
}
