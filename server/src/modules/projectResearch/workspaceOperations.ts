import type {ServerConfig} from '../../config.js';
import {ProjectResearchOrchestrator} from './orchestrator.js';
import {ProjectResearchStandingComparisonService} from './standingComparisonService.js';
import {sourceItemReadableClause} from '../sources/sourceItemAccess.js';
import {RESEARCH_WORKSPACE_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {assertProjectWriter,assertProjectReadable,assertProjectReadableLocked,canWriteProject,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {contentReadSql} from '../access/contentAccessSql.js';
import {ProjectResearchRepository} from './repository.js';
import {ProjectResearchAreaService} from './areaService.js';
import {ResearchWorkspaceMutationError} from './workspaceErrors.js';
import {researchWorkflowProjection} from './workflowOntology.js';
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {runReadSql} from '../access/contentAccessSql.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {ProjectResearchQuestionRefineService} from './questionRefineService.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Input={project_id:string;item_id?:string;claim_id?:string;claim_link_id?:string;workflow_id?:string|null;thread_id?:string;run_id?:string|null;source_item_id?:string;advice_id?:string;batch_id?:string};
async function discover(db:Queryable,i:Input,a:OperationActor){
 let claim=i.claim_id??null;
 if(i.claim_link_id){const link=(await db.query<{claim_id:string}>('SELECT claim_id FROM project_research_claim_links WHERE space_id=$1 AND project_id=$2 AND id=$3',[a.space_id,i.project_id,i.claim_link_id])).rows[0];if(!link)throw hidden();claim=link.claim_id;}
 const root=claim?(await db.query<{id:string;primary_project_id:string|null}>("SELECT so.id,so.primary_project_id FROM space_objects so JOIN claims c ON c.object_id=so.id AND c.space_id=so.space_id WHERE so.id=$1 AND so.space_id=$2 AND so.object_type='claim' AND so.deleted_at IS NULL",[claim,a.space_id])).rows[0]:null;
 if(claim&&!root)throw hidden();
 let source:{id:string;project_id:string|null;connection_id:string|null;parent_project_id:string|null}|null=null;
 if(i.source_item_id){
  source=(await db.query<{id:string;project_id:string|null;connection_id:string|null;parent_project_id:string|null}>('SELECT si.id,si.project_id,si.connection_id,sc.project_id AS parent_project_id FROM source_items si LEFT JOIN source_connections sc ON sc.id=si.connection_id AND sc.space_id=si.space_id WHERE si.id=$1 AND si.space_id=$2 AND si.deleted_at IS NULL',[i.source_item_id,a.space_id])).rows[0]??null;
  if(!source)throw hidden();
 }
 const workflow=i.workflow_id?(await db.query<{primary_thread_id:string|null}>(`SELECT pin.primary_thread_id FROM ${researchWorkflowProjection().from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3`,[i.workflow_id,a.space_id,i.project_id])).rows[0]:null;
 if(i.workflow_id&&!workflow)throw hidden();
 return {root:root??null,source,workflow:workflow??null};
}
export function researchWorkspaceRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return Object.keys(RESEARCH_WORKSPACE_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,successStatus:['research.question.assessment.confirm','research.checklist.create','research.claim.link','research.area.initialize'].includes(id)?201:200,
  async resolve(db,raw,a){const i=raw as Input,closure=await discover(db,i,a);return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,item_id:i.item_id??null,claim_link_id:i.claim_link_id??null,claim_id:closure.root?.id??null,source_project_id:closure.root?.primary_project_id??null,source:closure.source},resourceType:'project',resourceId:i.project_id,closure};},
  async authorize(db,raw,a,scope){const i=raw as Input,before=(scope as typeof scope&{closure:Awaited<ReturnType<typeof discover>>}).closure;
   if(id==='research.area.initialize'&&!await canWriteProject(db,a.space_id,i.project_id,a.on_behalf_of_user_id!)){
    await assertProjectReadableLocked(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
    if(!(await db.query('SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2',[a.space_id,i.project_id])).rows.length)throw hidden();return;
   }
   await assertProjectWriter(db,a.space_id,i.project_id,a.on_behalf_of_user_id!,{allowArchived:true});
   // Aggregate writer lock first; never upgrade a Project SHARE after a Claim lock.
   const projects=[...new Set([i.project_id,before.root?.primary_project_id,before.source?.project_id,before.source?.parent_project_id].filter((p):p is string=>!!p))].sort();
   try{for(const project of projects){if(project===i.project_id){await lockActiveProjectForMutation(db,a.space_id,project);await assertProjectWriterForMutation(db,a.space_id,project,a.on_behalf_of_user_id!);}else await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[project,a.space_id]);}}
   catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'research');throw e;}
   await db.query('SELECT id FROM project_members WHERE space_id=$1 AND user_id=$2 AND project_id=ANY($3::varchar[]) ORDER BY id FOR SHARE',[a.space_id,a.on_behalf_of_user_id,projects]);
   if(before.root){
    await db.query('SELECT id FROM space_objects WHERE id=$1 AND space_id=$2 FOR SHARE',[before.root.id,a.space_id]);
    await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=$2 ORDER BY id FOR SHARE',[a.space_id,before.root.id]);
    if(!(await db.query(`SELECT so.id FROM space_objects so WHERE so.id=$1 AND so.space_id=$2 AND so.deleted_at IS NULL AND ${contentReadSql('space_object','so','$3')}`,[before.root.id,a.space_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
   }
   if(before.source){
    const source=before.source;
    if(source.connection_id){
     await db.query('SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 FOR SHARE',[source.connection_id,a.space_id]);
     const channels=(await db.query<{id:string}>('SELECT id FROM source_channels WHERE space_id=$1 AND source_connection_id=$2 ORDER BY id FOR SHARE',[a.space_id,source.connection_id])).rows.map(r=>r.id);
     await db.query('SELECT id FROM source_channel_user_subscriptions WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[a.space_id,channels,a.on_behalf_of_user_id]);
     await db.query('SELECT id FROM source_channel_subscription_windows WHERE space_id=$1 AND source_channel_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[a.space_id,channels,a.on_behalf_of_user_id]);
    }
    await db.query('SELECT id FROM source_items WHERE id=$1 AND space_id=$2 FOR SHARE',[source.id,a.space_id]);
    await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,[source.id,source.connection_id].filter(Boolean)]);
    if(!(await db.query(`SELECT si.id FROM source_items si WHERE si.id=$1 AND si.space_id=$2 AND si.deleted_at IS NULL AND ${sourceItemReadableClause('si','$3',false)}`,[source.id,a.space_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
   }
   if(canonical(await discover(db,i,a))!==canonical(before))throw new OperationError('operation_conflict',409);
   const roots=[...new Set([i.thread_id,i.workflow_id,before.workflow?.primary_thread_id].filter((id):id is string=>!!id))].sort();
   if(roots.length){await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE',[a.space_id,roots]);await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[a.space_id,roots]);}
   for(const thread of new Set([i.thread_id,before.workflow?.primary_thread_id].filter((id):id is string=>!!id))){await assertThreadReadable(db,person(a),i.project_id,thread,'change');if(id==='research.question.assessment.confirm')await assertThreadReadable(db,person(a),i.project_id,thread,'read_content');}
   if(id==='research.question.assessment.confirm')await db.query('SELECT id FROM project_research_question_assessment_sessions WHERE space_id=$1 AND project_id=$2 AND thread_id=$3 FOR UPDATE',[a.space_id,i.project_id,i.thread_id]);
   if(i.workflow_id){
    if(!(await db.query('SELECT object_id FROM project_research_workflows WHERE object_id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.workflow_id,a.space_id,i.project_id])).rows.length)throw hidden();
    const projection=researchWorkflowProjection({viewerPlaceholder:'$4'});
    if(!(await db.query(`SELECT w.object_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate}`,[i.workflow_id,a.space_id,i.project_id,a.on_behalf_of_user_id])).rows.length)throw hidden();
   }
   if(i.run_id){if(!(await db.query(`SELECT r.id FROM runs r WHERE r.id=$1 AND r.space_id=$2 AND r.project_id=$3 AND ${runReadSql('$4','r',{includeOversight:false})} FOR SHARE OF r`,[i.run_id,a.space_id,i.project_id,a.on_behalf_of_user_id])).rows.length||await contentDecisionFromDb(db,person(a),'run',i.run_id,{includeOversight:false})!=='full')throw hidden();}
   if(canonical(await discover(db,i,a))!==canonical(before))throw new OperationError('operation_conflict',409);
   if(i.advice_id&&!(await db.query('SELECT id FROM project_research_standing_advice WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.advice_id,a.space_id,i.project_id])).rows.length)throw hidden();
   if(i.batch_id&&!(await db.query('SELECT id FROM project_research_standing_batches WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.batch_id,a.space_id,i.project_id])).rows.length)throw hidden();
   if(i.claim_link_id)await db.query('SELECT id FROM project_research_claim_links WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.claim_link_id,a.space_id,i.project_id]);
   // Deletion replay intentionally needs only current Project authority. It must
   // not delete a newly created item, nor require its old row to still exist.
   if(i.item_id)await db.query('SELECT id FROM research_checklist_items WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE',[i.item_id,a.space_id,i.project_id]);
  },
  async authorizeResult(db,raw,a){const out=raw as {id:string;project_id:string;space_id:string;thread_id?:string};if(out.space_id!==a.space_id)throw hidden();if(id==='research.area.initialize')await assertProjectReadable(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);else await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);if(id==='research.question.assessment.confirm'){await assertThreadReadable(db,person(a),out.project_id,out.thread_id!,'change');await assertThreadReadable(db,person(a),out.project_id,out.thread_id!,'read_content');if(!(await db.query("SELECT id FROM project_research_context_versions WHERE id=$1 AND space_id=$2 AND project_id=$3 AND provenance_json->>'source'='question_assessment_confirmation' AND provenance_json->>'thread_id'=$4",[out.id,a.space_id,out.project_id,out.thread_id])).rows.length)throw hidden();}},
  async execute(db,raw,a){const i=raw as Input,body=raw as Record<string,unknown>,p=person(a),repo=new ProjectResearchRepository(db),area=new ProjectResearchAreaService(db);let result:Record<string,unknown>;
   switch(id){
    case 'research.question.assessment.confirm':{const confirmation=await new ProjectResearchQuestionRefineService(db,config).confirm(p,i.project_id,body);return {id:confirmation.research_context_version_id,space_id:a.space_id,project_id:i.project_id,thread_id:i.thread_id};}
    case 'research.intake.draft':result=await new ProjectResearchOrchestrator(db,config).saveInitialIntakeDraft(p,i.project_id,body);break;
    case 'research.workflow.stage.record':result=await repo.runStage(p,i.project_id,i.workflow_id!,body.stage_key as string,body);break;
    case 'research.intake.limit':result=await new ProjectResearchOrchestrator(db,config).updateInitialItemLimit(p,i.project_id,body);break;
    case 'research.standing.dismiss':result=await new ProjectResearchStandingComparisonService(db,config).dismissAdvice(p,i.project_id,i.advice_id!);break;
    case 'research.standing.retry':result=await new ProjectResearchStandingComparisonService(db,config).retryBatch(p,i.project_id,i.batch_id!);break;
    case 'research.area.initialize':{const areaResult=await area.initializeArea(p,i.project_id);result={id:areaResult.notes_collection_id};break;}
    case 'research.evidence_card.update':result=await area.upsertEvidenceCard(p,i.project_id,i.source_item_id!,body);break;
    case 'research.checklist.create':result=await area.createChecklistItem(p,i.project_id,body);break;
    case 'research.checklist.update':result=await area.updateChecklistItem(p,i.project_id,i.item_id!,body);break;
    case 'research.checklist.delete':result=await area.deleteChecklistItem(p,i.project_id,i.item_id!);break;
    case 'research.claim.link':result=await repo.createClaimLink(p,i.project_id,body);break;
    case 'research.claim.update':result=await repo.updateClaimLink(p,i.project_id,i.claim_link_id!,body);break;
    case 'research.screening.configure':result=await repo.upsertScreeningCriteria(p,i.project_id,body);break;
    default:throw new Error('Unregistered Research workspace command');
   }
   return {id:result.id,space_id:a.space_id,project_id:i.project_id};
  },
  classifyError(e){if(e instanceof ResearchWorkspaceMutationError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'research');return undefined;},
 }));
}
