import type { FrozenRevisionMethod } from './revisionMethod.js';
import type { RuntimeSessionConfigSelection } from '@rainver/protocol';
import { ReadingMethodGeneratedOutputSchema } from '@rainver/protocol';
import { declaredStructuredOutput, runOutputResult } from '../../runs/orchestrationResults.js';
import type { RunRecord } from '../../runs/repository.js';
export const GENERATION_KIND = 'reading_method_generation.v1';
export const GENERATION_SCHEMA = 'reading_method_revision.v1';
export const generationTerminal = new Set(['succeeded', 'degraded', 'failed', 'cancelled', 'orphaned']);
export interface GenerationRef {
  kind: typeof GENERATION_KIND;
  target_key?: 'reading.project_investigation'|'prompt.revision.method';
  provider?: import('./revisionProvider.js').RevisionProvider;
  revision_method?: FrozenRevisionMethod;
  source_kind: 'description';
  item_id: string | null;
  scope_only?: true;
  project_id: string | null;
  authority: string;
  parent_version_id: string;
  parent_hash: string;
  description: string;
  prompt_hash: string;
  profile_hash: string;
  session_config: RuntimeSessionConfigSelection[];
  execution_name: string;
  request_key: string;
  input_key: string;
}
export function generationOf(run: Pick<RunRecord, 'contract_snapshot_json'>): GenerationRef | undefined {
  return (run.contract_snapshot_json as {
    workflow_input_json?: {
      reading_method_generation?: GenerationRef;
    };
  } | null)?.workflow_input_json?.reading_method_generation;
}
export function generatedOutput(run: Pick<RunRecord, 'output_json'>) {
  const output = run.output_json as {
    summary?: unknown;
  } | null;
  const result = runOutputResult(output);
  const values = [result.structured_output, result];
  for (const value of [result.output_text, output?.summary]) if (typeof value === 'string') values.push(declaredStructuredOutput(value, GENERATION_SCHEMA));
  for (const value of values) {
    const parsed = ReadingMethodGeneratedOutputSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}
export function generationVersionRefs(content: unknown): string[] {
 const id=(content as {reading_generation?:{origin_run_id?:unknown}}|null)?.reading_generation?.origin_run_id;
 return typeof id==='string'&&id?[id]:[];
}

export function readingProviderOf(run:Pick<RunRecord,'contract_snapshot_json'>){return generationOf(run)?.provider??(run.contract_snapshot_json as {workflow_input_json?:{reading_method_trial?:{provider?:import('./revisionProvider.js').RevisionProvider}}})?.workflow_input_json?.reading_method_trial?.provider;}
