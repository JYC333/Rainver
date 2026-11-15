import {withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {releaseGatedArtifactType,retrievalArtifactWithheld} from './artifactRelease.js';
import {proposalReportDependencies} from './proposalReportDependencies.js';
export {proposalReportDependencies,withheldProposalTitle} from './proposalReportDependencies.js';

/** Whether a report-derived Proposal's title, summary, rationale and
 * provenance must be withheld from this person NOW: every report Artifact it
 * derives from must exist, be a release-gated report and pass that report's
 * current closure (`retrievalArtifactWithheld` — report authority, every
 * referenced object `full` with its canonical Source policy, nested reports
 * recursively). Decision only; the Proposal's own visibility, approval and
 * revision gates are unchanged. One transaction, so a read waits on an
 * uncommitted withdrawal and sees its outcome. */
export async function proposalReportWithheld(db:Queryable,identity:SpaceUserIdentity,proposal:{proposal_type:string;payload_json:unknown}):Promise<boolean>{
 const deps=proposalReportDependencies(proposal.proposal_type,proposal.payload_json);
 if(!deps)return false;
 if(deps.malformed)return true;
 return withQueryableTransaction(db,async tx=>{
  for(const artifactId of deps.artifactIds){
   const row=(await tx.query<{id:string;artifact_type:string;metadata_json:unknown}>('SELECT id,artifact_type,metadata_json FROM artifacts WHERE space_id=$1 AND id=$2',[identity.spaceId,artifactId])).rows[0];
   if(!row||!releaseGatedArtifactType(row.artifact_type))return true;
   if(await retrievalArtifactWithheld(tx,identity,row,null))return true;
  }
  return false;
 });
}
