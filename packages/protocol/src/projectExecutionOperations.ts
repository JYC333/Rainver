import { z } from 'zod';

const id = z.string().trim().min(1).max(36);
const text = z.string().transform(value => value.trim() || null).nullable();
const project = { project_id: id };
const definition = { ...project, definition_id: id };
const version = { ...definition, version_id: id };
const run = { ...definition, experiment_run_id: id };
const interpretation = { ...project, interpretation_id: id };
const receipt = z.object({ id, space_id: id, project_id: id, definition_id: id }).strict();
const strings = z.array(z.string().trim().min(1));
const observation = z.object({
  metric_name: z.string().trim().min(1), value_number: z.number().finite().nullable().default(null),
  value_text: text.default(null), value_json: z.unknown().nullable().default(null),
  is_primary: z.boolean().default(false), source: z.enum(['manual', 'parsed', 'agent']).default('manual'),
}).strict().refine(value => value.value_number !== null || value.value_text !== null || value.value_json !== null,
  'An observation requires a value');
const runFields = {
  is_baseline: z.boolean().default(false), hypothesis: text.default(null),
  patch_summary: text.default(null), commit_ref: text.default(null),
};
const managedConfig = z.object({
  project_folder_id: id, editable_scope: strings.default([]), protected_scope: strings.default([]),
  setup_commands: strings.default([]), run_command: z.string().nullable().default(null),
  metric_parser: z.record(z.unknown()).default({}),
  time_budget_seconds: z.number().int().positive().nullable().default(null),
  timeout_seconds: z.number().int().positive().nullable().default(null),
  resource_budget: z.record(z.unknown()).default({}),
}).strict();

export const PROJECT_EXECUTION_SCHEMAS = {
  'experiment.definition.create': { input: z.object({ ...project, name: z.string().trim().min(1), objective: text.default(null), primary_hypothesis_thread_id: id.nullable().default(null) }).strict(), output: receipt },
  'experiment.definition.update': { input: z.object({ ...definition, objective: text.optional(), primary_hypothesis_thread_id: id.nullable().optional(), status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']).optional() }).strict(), output: receipt },
  'experiment.version.create': { input: z.discriminatedUnion('executor_type', [
    z.object({ ...definition, executor_type: z.literal('manual'), config: z.object({}).strict().default({}), planned_summary: text.default(null), status: z.literal('draft').default('draft') }).strict(),
    z.object({ ...definition, executor_type: z.literal('managed_code_comparison'), config: managedConfig, planned_summary: text.default(null), status: z.literal('draft').default('draft') }).strict(),
  ]), output: receipt },
  'experiment.version.approve': { input: z.object(version).strict(), output: receipt },
  'experiment.run.create': { input: z.object({ ...version, ...runFields, run_id: id.nullable().default(null) }).strict(), output: receipt },
  'experiment.run.launch': { input: z.object({ ...version, ...runFields, agent_id: id, runtime_profile_id: id.nullable().default(null) }).strict(), output: receipt },
  'experiment.run.complete': { input: z.object({ ...run, status: z.enum(['completed', 'failed', 'cancelled']), artifact_ids: z.array(id).transform(ids => [...new Set(ids)]).default([]), observations: z.array(observation).default([]), mark_as_best: z.boolean().default(false) }).strict(), output: receipt },
  'experiment.observation.record': { input: z.object({ ...run, ...observation.innerType().shape }).strict().refine(value => value.value_number !== null || value.value_text !== null || value.value_json !== null, 'An observation requires a value'), output: receipt },
  'experiment.interpretation.create': { input: z.object({ ...definition, run_ids: z.array(id).min(1).transform(ids => [...new Set(ids)]), verdict: z.enum(['supports', 'contradicts', 'inconclusive']), conclusion: text.default(null), negative_results: text.default(null), limitations: text.default(null), repro_lock: z.record(z.unknown()).default({}) }).strict(), output: receipt },
  'experiment.interpretation.review': { input: z.object(interpretation).strict(), output: receipt },
  'experiment.interpretation.convert': { input: z.object({ ...interpretation, confidence: z.number().finite().min(0).max(1).nullable().default(null) }).strict(), output: receipt },
} as const;

export const PROJECT_EXECUTION_TITLES: Record<keyof typeof PROJECT_EXECUTION_SCHEMAS, string> = {
  'experiment.definition.create': 'Create an Experiment Definition',
  'experiment.definition.update': 'Update an Experiment Definition',
  'experiment.version.create': 'Create an immutable Experiment Version',
  'experiment.version.approve': 'Approve an Experiment Version',
  'experiment.run.create': 'Create an Experiment Run',
  'experiment.run.launch': 'Launch a managed Experiment Run',
  'experiment.run.complete': 'Complete an Experiment Run',
  'experiment.observation.record': 'Record an Experiment Observation',
  'experiment.interpretation.create': 'Create an Experiment Interpretation',
  'experiment.interpretation.review': 'Review an Experiment Interpretation',
  'experiment.interpretation.convert': 'Convert a reviewed Experiment to an Inquiry Signal',
};
