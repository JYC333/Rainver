import {OperationError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {isContentOwner} from '../access/contentAccessPolicy.js';
import {contentResourceDefinition} from '../access/contentAccessRegistry.js';
import {registeredEntities,resolveContentResourceType,isProvenanceSourceType} from '../ontology/entities.js';
import {assertProjectReadableLocked,assertProjectWriterForMutation} from '../projects/access.js';
import {lockActivePerson} from '../access/activePerson.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import type {Queryable} from '../routeUtils/common.js';
type Input=Record<string,any>;
type Ref={type:string;id:string;project:string|null;folder:string|null;shares:string[]};
type Bound={target:string|null;refs:Ref[];projects:string[]};
type Authority={space_id:string;on_behalf_of_user_id:string|null};
const person=(a:Authority)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
function references(i:Input):{type:string;id:string}[]{
 const out:{type:string;id:string}[]=[];
 for(const key of ['item_id','claim_id','subject_object_id','holder_object_id','superseded_by_claim_id','from_object_id','to_object_id','source_claim_id','source_object_id'])if(i[key])out.push({type:'space_object',id:i[key]});
 for(const s of i.sources??[]){if(s.source_object_id)out.push({type:'space_object',id:s.source_object_id});if(s.source_connection_id)out.push({type:'source_connection',id:s.source_connection_id});if(s.source_ref_id&&!['external_pointer','run_event'].includes(s.source_ref_type))out.push({type:s.source_ref_type,id:s.source_ref_id});}
 for(const s of i.source_refs??[]){
  const sourceType=s.source_type??s.type,sourceId=s.source_id??s.id;
  // Registry is the only authority for source tokens; metadata sentinels are
  // checked at the canonical provenance writer, not treated as object grants.
  const entity=registeredEntities().find(d=>d.provenanceSourceable?.sourceType===sourceType);
  const type=entity&&resolveContentResourceType(entity.entityType);
  if(type&&contentResourceDefinition(type))out.push({type,id:sourceId});
  else if(!isProvenanceSourceType(sourceType))throw new OperationError('operation_invalid_input',422);
 }
 return [...new Map(out.map(r=>[r.type+':'+r.id,r])).values()].sort((a,b)=>(a.type+':'+a.id).localeCompare(b.type+':'+b.id));
}
export async function discoverKnowledgeProposalAuthority(db:Queryable,i:Input,a:Authority):Promise<Bound>{
 const refs=references(i);
 for(const source of i.sources??[])if(source.source_ref_type==='run_event'){const row=(await db.query<{run_id:string}>('SELECT run_id FROM run_events WHERE id=$1 AND space_id=$2',[source.source_ref_id,a.space_id])).rows[0];if(!row)throw hidden();refs.push({type:'run',id:row.run_id});}
 const projects=new Set<string>(i.project_id?[i.project_id]:[]);
 if(i.relation_id){const row=(await db.query<{from_object_id:string;to_object_id:string}>('SELECT from_object_id,to_object_id FROM object_relations WHERE id=$1 AND space_id=$2',[i.relation_id,a.space_id])).rows[0];if(!row)throw hidden();refs.push({type:'space_object',id:row.from_object_id},{type:'space_object',id:row.to_object_id});}
 const found:Ref[]=[];
 for(const r of [...new Map(refs.map(r=>[r.type+':'+r.id,r])).values()].sort((a,b)=>(a.type+':'+a.id).localeCompare(b.type+':'+b.id))){
  const d=contentResourceDefinition(r.type);if(!d)throw new OperationError('operation_invalid_input',422);
  const row=(await db.query<{project:string|null;folder:string|null}>(`SELECT ${d.projectColumn??'NULL'} AS project,${d.projectFolderColumn??'NULL'} AS folder FROM ${d.tableName} WHERE space_id=$1 AND id=$2`,[a.space_id,r.id])).rows[0];if(!row)throw hidden();
  const shares=d.projectShare?(await db.query<{project:string}>(`SELECT ${d.projectShare.projectColumn} AS project FROM ${d.projectShare.tableName} WHERE space_id=$1 AND ${d.projectShare.resourceColumn}=$2 AND ${d.projectShare.revokedColumn} IS NULL ORDER BY ${d.projectShare.projectColumn}`,[a.space_id,r.id])).rows.map(r=>r.project):[];
  if(row.project)projects.add(row.project);for(const project of shares)projects.add(project);found.push({...r,...row,shares});
 }
 const folders=[...new Set(found.flatMap(r=>r.folder?[r.folder]:[]).concat(i.project_folder_id?[i.project_folder_id]:[]))].sort();
 for(const id of folders){const row=(await db.query<{project_id:string|null}>('SELECT project_id FROM project_folders WHERE space_id=$1 AND id=$2',[a.space_id,id])).rows[0];if(!row)throw hidden();if(row.project_id)projects.add(row.project_id);}
 return {target:i.item_id??i.claim_id??i.relation_id??null,refs:found,projects:[...projects].sort()};
}
// applying=true is the Proposal apply-time replay: it locks roots FOR UPDATE and
// replays the proposer's current Project read and source authority, but approval
// belongs to ProposalApplyService, so a later writer demotion of the submitter
// does not block an authorized approver. Submission (false) requires writer.
export async function lockKnowledgeProposalAuthority(db:Queryable,i:Input,a:Authority,b:Bound,applying=false):Promise<void>{
  if(canonical(await discoverKnowledgeProposalAuthority(db,i,a))!==canonical(b))throw new OperationError('operation_conflict',409);
  const sourceRefs=b.refs.filter(r=>['source_item','extracted_evidence','source_snapshot','source_connection'].includes(r.type)).map(r=>({object_type:r.type as 'source_item'|'extracted_evidence'|'source_snapshot'|'source_connection',object_id:r.id}));
  if(sourceRefs.length)await lockSourceRetrievalRelease(db,a.space_id,a.on_behalf_of_user_id!,sourceRefs,b.projects);
  for(const project of b.projects)await(!applying&&(project===i.project_id||b.refs.some(r=>r.id===b.target&&r.project===project))?assertProjectWriterForMutation:assertProjectReadableLocked)(db,a.space_id,project,a.on_behalf_of_user_id!);
  await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);
  const folders=[...new Set(b.refs.flatMap(r=>r.folder?[r.folder]:[]).concat(i.project_folder_id?[i.project_folder_id]:[]))].sort();
  for(const folder of folders){const row=(await db.query<{project_id:string|null}>('SELECT project_id FROM project_folders WHERE id=$1 AND space_id=$2 FOR SHARE',[folder,a.space_id])).rows[0];if(!row)throw hidden();if(folder===i.project_folder_id&&row.project_id!==(i.project_id??null))throw new OperationError('operation_conflict',409);}
  for(const r of b.refs){const d=contentResourceDefinition(r.type)!;await db.query(`SELECT id FROM ${d.tableName} WHERE space_id=$1 AND id=$2 ${applying&&r.type==='space_object'?'FOR UPDATE':'FOR SHARE'}`,[a.space_id,r.id]);if(d.projectShare)await db.query(`SELECT ${d.projectShare.projectColumn} FROM ${d.projectShare.tableName} WHERE space_id=$1 AND ${d.projectShare.resourceColumn}=$2 ORDER BY ${d.projectShare.projectColumn} FOR SHARE`,[a.space_id,r.id]);await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_type=$2 AND resource_id=$3 ORDER BY id FOR SHARE',[a.space_id,r.type,r.id]);if(await contentDecisionFromDb(db,person(a),r.type,r.id,{includeOversight:false})!=='full')throw hidden();}
  if(i.relation_id)await db.query('SELECT id FROM object_relations WHERE id=$1 AND space_id=$2 FOR SHARE',[i.relation_id,a.space_id]);
  if(canonical(await discoverKnowledgeProposalAuthority(db,i,a))!==canonical(b))throw new OperationError('operation_conflict',409);
  if(i.item_id||i.claim_id){const row=(await db.query<{owner_user_id:string|null;created_by_user_id:string|null}>('SELECT owner_user_id,created_by_user_id FROM space_objects WHERE id=$1 AND space_id=$2',[b.target,a.space_id])).rows[0];if(!row||!isContentOwner(row,a.on_behalf_of_user_id))throw hidden();}
 }
