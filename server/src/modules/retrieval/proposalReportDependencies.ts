/** Report packet Proposals and the payload key naming the report Artifact
 * their title, summary (`proposed_content`) and findings were generated from. */
const REPORT_PACKET_ARTIFACT_KEY:Readonly<Record<string,string>>={
 retrieval_maintenance_packet:'report_artifact_id',
 memory_maintenance_packet:'report_artifact_id',
 retrieval_diagnostics_packet:'report_artifact_id',
 relation_discovery_packet:'report_artifact_id',
 claim_candidate_packet:'packet_artifact_id',
};
/** Keys by which a child Proposal (generated when a packet is accepted)
 * names the report it was derived from. */
const CHILD_REPORT_ARTIFACT_KEYS=['report_artifact_id','source_report_artifact_id','source_maintenance_report_artifact_id','source_candidate_packet_artifact_id'] as const;
/** Packet producers that freeze their packet context beside the child's own
 * payload under `payload.metadata.<key>` instead of at the top level (the
 * shared child INSERT stores each producer's payload as built):
 *  - Claim Candidate Packet → `claim_create` / `object_relation_create`:
 *    `metadata.claim_candidate_packet.{source_candidate_packet_artifact_id,
 *    provenance_entries}`, plus the candidate's own
 *    `metadata.source_artifact_ids` (the Brief / maintenance / diagnostics /
 *    Memory maintenance / contradiction report it was read from).
 *  - Relation discovery packet → `object_relation_create` /
 *    `knowledge_create`: `metadata.relation_discovery_packet.source_report_artifact_id`.
 * A child carrying such a context is report-derived; one whose context names
 * no report (an older or damaged record) cannot be checked and fails closed. */
const NESTED_PACKET_CONTEXT_KEYS=['claim_candidate_packet','relation_discovery_packet'] as const;

const record=(v:unknown)=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const id=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;

/** Report Artifact ids one payload level names: the child report keys and
 * any `derived_review` Artifact provenance entry. */
function levelReportIds(level:Record<string,unknown>,ids:Set<string>):void{
 for(const key of CHILD_REPORT_ARTIFACT_KEYS){const v=id(level[key]);if(v)ids.add(v);}
 for(const entry of Array.isArray(level.provenance_entries)?level.provenance_entries:[]){
  const e=record(entry);if(e?.source_type==='artifact'&&e.source_trust==='derived_review'){const v=id(e.source_id);if(v)ids.add(v);}
 }
}

/** The report Artifacts a Proposal's displayed fields derive from, frozen in
 * its payload when it was generated: a packet's report (required — a packet
 * without one cannot be checked), a child's source report at the top level
 * (retrieval / Memory maintenance children) or inside its nested packet
 * context (claim / relation discovery children), and any `derived_review`
 * Artifact provenance entry. `null` when the Proposal is not report-derived
 * (every other Proposal keeps its own gates only). */
export function proposalReportDependencies(proposalType:string,payloadJson:unknown):{artifactIds:string[];malformed:boolean}|null{
 const payload=record(payloadJson)??{};
 const ids=new Set<string>();let malformed=false;
 const packetKey=REPORT_PACKET_ARTIFACT_KEY[proposalType];
 if(packetKey){const v=id(payload[packetKey]);if(v)ids.add(v);else malformed=true;}
 levelReportIds(payload,ids);
 const metadata=record(payload.metadata);
 let nested=false;
 for(const key of NESTED_PACKET_CONTEXT_KEYS){
  if(!metadata||metadata[key]===undefined||metadata[key]===null)continue;
  nested=true;
  const context=record(metadata[key]);
  const named=new Set<string>();
  if(context)levelReportIds(context,named);
  if(key==='claim_candidate_packet'&&Array.isArray(metadata.source_artifact_ids))for(const v of metadata.source_artifact_ids){const s=id(v);if(s)named.add(s);}
  if(!named.size)malformed=true;
  for(const v of named)ids.add(v);
 }
 return packetKey||nested||ids.size?{artifactIds:[...ids],malformed}:null;
}

/** A withheld report-derived Proposal's type label replaces its stored
 * (count-bearing) title. */
export const withheldProposalTitle=(proposalType:string)=>proposalType.split('_').map((w,n)=>n?w:w[0]!.toUpperCase()+w.slice(1)).join(' ');
