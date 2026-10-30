import type {SourceConnectionRow} from '../sourceRepositoryRows.js';
/** Existing sources retain their actual policy; creating a new draft does not
 * silently broaden any previously accepted source. */
export function agentReadingPolicy(source:Pick<SourceConnectionRow,'capture_policy'|'policy_json'>){
 const retention=String((source.policy_json as Record<string,unknown>|null)?.retention_policy??'metadata_only');
 const summary=source.capture_policy!=='reference_only'&&['summary_only','full_text','full_snapshot','archived'].includes(retention);
 return {capture:source.capture_policy,retention,summary,content:summary&&retention!=='summary_only'};
}
