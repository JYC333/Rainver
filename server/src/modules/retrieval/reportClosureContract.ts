const record=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
/** Version of the dependency-closure contract a stored aggregate report
 * records (`dependency_closure.version`). Producers that aggregate — the
 * product diagnostics eval report and the object schema suggestion report —
 * write the complete set of contributing objects/Artifacts beside the numbers
 * and stamp this version. A stored aggregate without it (an older record
 * whose producer dropped the references) cannot be rechecked and fails
 * closed; a stamped report with an empty closure is a legitimate empty
 * report and is released. */
export const REPORT_DEPENDENCY_CLOSURE_VERSION=1;
export const reportDependencyClosureMarker=()=>({version:REPORT_DEPENDENCY_CLOSURE_VERSION});
/** A schema suggestion finding counts the visible rows behind it; every one
 * of those rows must be named in `evidence_refs` (one per counted row) so a
 * later withdrawal reaches the finding. A published Project public summary
 * is no exception: its ref is the Project id, rechecked against the current
 * publication, active Project and the publication's Source references. A
 * zero count with no refs is a legitimate empty finding. */
export function schemaSuggestionFindingsClosed(findings:unknown):boolean{
 if(!Array.isArray(findings))return false;
 return findings.every(f=>{
  const r=record(f);if(!r||!Array.isArray(r.evidence_refs))return false;
  const count=Number(r.visible_usage_count);if(!Number.isInteger(count)||count<0)return false;
  if(!r.evidence_refs.every(o=>{const v=record(o);return Boolean(v&&typeof v.object_type==='string'&&v.object_type&&typeof v.object_id==='string'&&v.object_id);}))return false;
  return r.evidence_refs.length===count;
 });
}
