import {discoverPublicSummaryRun,authorizePublicSummaryRun} from './publicSummaryAdmission.js';
import {enqueueRetrievalEmbeddingBackfillWithQueue} from '../retrieval/embedding/job.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {ServerConfig} from '../../config.js';
import {ProjectResearchAreaService} from '../projectResearch/areaService.js';
import {discoverNotebookChat,authorizeNotebookChat,NotebookSessionProjectError} from '../projectResearch/notebookChatAdmission.js';
import {NotebookChatMutationError,NotebookChatBudgetError} from '../projectResearch/notebookChatErrors.js';
import {FocusAreaService,FocusAreaArchivedError} from '../focusAreas/service.js';
import {ProjectReviewSessionService} from '../projectReview/service.js';
import {reportProjectUpdate} from '../projectWork/reportService.js';
import {undoProjectUpdate} from '../projectWork/updateUndo.js';
import {discoverUpdateUndo,authorizeUpdateUndo} from '../projectWork/updateUndoAdmission.js';
import {ProjectUpdateUndoError} from '../projectWork/updateUndoError.js';
import {InquiryMutationError} from '../inquiry/operationErrors.js';
import {PROJECT_MANAGEMENT_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {optionalString} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {assertProjectReadableLocked,assertProjectReadable,assertProjectWriter,assertProjectWriterForMutation,assertProjectOwnerLevelForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError,lockProjectAudienceForChange} from './access.js';
import {PgProjectRepository,projectArchiveRunRefs} from './repository.js';
import {ProjectKernelService} from './kernelService.js';
import {ProjectAttentionService} from './attentionService.js';
import {DecisionCaseService} from '../decisions/caseService.js';
import {DecisionMutationError} from '../decisions/mutationError.js';
import {ProjectManagementMutationError} from './managementErrors.js';
type Input={project_id:string;user_id?:string;role?:string;version_id?:string;source_type?:string;source_id?:string;case_id?:string;commitment_id?:string;source_thread_ids?:string[];focus_area_id?:string|null;event_id?:string;source_item_ids?:string[];session_id?:string|null;generated_by_run_id?:string|null};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const ownerCommands=new Set(['project.brief.publish','project.instruction.create','project.instruction.submit_review','project.instruction.publish']);
async function authorize(db:Queryable,id:string,i:Input,a:OperationActor){
 const p=person(a);
 if(id==='project.create')return; // The core verifies and locks active Space/person membership.
 if(id==='project.public_summary.publish'||id==='project.public_summary.revoke'){await assertProjectWriter(db,p.spaceId,i.project_id,p.userId,{allowArchived:true});if(!(await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[i.project_id,p.spaceId])).rows.length)throw hidden();await assertProjectOwnerLevelForMutation(db,p.spaceId,i.project_id,p.userId);return;}
 if(id==='project.update'||id==='project.archive'){await assertProjectWriter(db,p.spaceId,i.project_id,p.userId,{allowArchived:true});if(!(await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE',[i.project_id,p.spaceId])).rows.length)throw hidden();await assertProjectWriterForMutation(db,p.spaceId,i.project_id,p.userId);return;}
 if(id==='project.attention.set_state'){await assertProjectReadableLocked(db,p.spaceId,i.project_id,p.userId);return;}
 if(id.startsWith('project.member.')){
  await lockProjectAudienceForChange(db,p.spaceId,i.project_id);
  await db.query('SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[p.spaceId,[p.userId,i.user_id].sort()]);
  await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE',[p.spaceId,i.project_id]);
  await new PgProjectRepository(db).authorizeMemberChange(p,i.project_id,i.user_id!,id==='project.member.add'?i.role:undefined);return;
 }
 await assertProjectWriter(db,p.spaceId,i.project_id,p.userId,{allowArchived:true});
 await lockActiveProjectForMutation(db,p.spaceId,i.project_id);
 if(ownerCommands.has(id))await assertProjectOwnerLevelForMutation(db,p.spaceId,i.project_id,p.userId);
 else await assertProjectWriterForMutation(db,p.spaceId,i.project_id,p.userId);
 if(id==='project.focus_area.set')await new FocusAreaService(db).authorizeProjectClassification(p,i.focus_area_id??null);
 if(i.version_id){const table=id.startsWith('project.brief.')?'project_brief_versions':'project_instruction_versions';if(!(await db.query(`SELECT id FROM ${table} WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR UPDATE`,[i.version_id,p.spaceId,i.project_id])).rows.length)throw hidden();}
 if(id.startsWith('decision.'))await new DecisionCaseService(db).authorizeMutation(p,i.project_id,{caseId:i.case_id,sourceThreadIds:i.source_thread_ids});
}
export function projectManagementRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return Object.keys(PROJECT_MANAGEMENT_SCHEMAS).map(id=>({
  definition:definitions.get(id)!,
  ...(['project.update','project.archive'].includes(id)?{runTerminalOwner:{async discover(db:Queryable,raw:unknown,a:OperationActor){
    const i=raw as Input,requested=optionalString((raw as Record<string,unknown>).status);
    const current=(await db.query<{status:string}>('SELECT status FROM projects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[i.project_id,a.space_id])).rows[0];
    return id==='project.archive'||(requested??current?.status)==='archived'?projectArchiveRunRefs(db,a.space_id,i.project_id):[];
  }}}:{}),successStatus:id==='project.notebook.chat'||id==='project.update.report'||id==='project.review_session.open'||id==='project.create'||id.endsWith('.create')||id==='decision.option.add'||id==='decision.criterion.add'||id==='decision.commitment.add'||id==='decision.commitment.deliver'||id==='decision.option.score'||id==='project.member.add'?201:200,
  async resolve(db,raw,a){const i=raw as Input;return {authority:id==='project.create'?`person:${a.on_behalf_of_user_id}`:`project:${i.project_id}`,targets:{project_id:i.project_id??null,version_id:i.version_id??null,user_id:i.user_id??null,case_id:i.case_id??null,commitment_id:i.commitment_id??null,source_type:i.source_type??null,source_id:i.source_id??null,event_id:i.event_id??null,focus_area_id:i.focus_area_id??null},resourceType:'project',resourceId:i.project_id??null,
    undo:id==='project.update.undo'?await discoverUpdateUndo(db,i.project_id,i.event_id!,a):null,
    summaryRun:id==='project.public_summary.save'?await discoverPublicSummaryRun(db,a.space_id,i.project_id,i.generated_by_run_id??null):null,
    notebook:id==='project.notebook.chat'?await discoverNotebookChat(db,person(a),i.project_id,i.source_item_ids??[]):null,
    review:id==='project.review_session.open'?await new ProjectReviewSessionService(db).discoverAdmission(i.project_id,a):null};},
  async authorize(db,raw,a,scope){const i=raw as Input,closure=scope as typeof scope&{undo:Awaited<ReturnType<typeof discoverUpdateUndo>>;review:Awaited<ReturnType<ProjectReviewSessionService['discoverAdmission']>>;notebook:Awaited<ReturnType<typeof discoverNotebookChat>>;summaryRun:Awaited<ReturnType<typeof discoverPublicSummaryRun>>};
   try{
    if(id==='project.public_summary.save'&&i.generated_by_run_id){
      const projects=[...new Set([i.project_id,closure.summaryRun?.room_project_id].filter((id):id is string=>!!id))].sort();
      for(const project of projects)await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 '+(project===i.project_id?'FOR UPDATE':'FOR SHARE'),[project,a.space_id]);
      await db.query('SELECT id FROM project_members WHERE space_id=$1 AND project_id=ANY($2::varchar[]) AND user_id=$3 ORDER BY id FOR SHARE',[a.space_id,projects,a.on_behalf_of_user_id]);
    }
    if(id==='project.notebook.chat')return await authorizeNotebookChat(db,person(a),i.project_id,i.source_item_ids??[],closure.notebook,i.session_id);
    if(id==='project.update.undo')return await authorizeUpdateUndo(db,i.project_id,i.event_id!,a,closure.undo);
    if(id==='project.review_session.open')return await new ProjectReviewSessionService(db).authorizeAdmission(i.project_id,a,closure.review);
    await authorize(db,id,i,a);
    if(id==='project.public_summary.save')await authorizePublicSummaryRun(db,person(a),i.project_id,i.generated_by_run_id??null,closure.summaryRun);
   }catch(e){if(e instanceof ProjectArchivedMutationError||e instanceof ProjectManagementMutationError||e instanceof DecisionMutationError||e instanceof FocusAreaArchivedError||e instanceof NotebookChatMutationError||e instanceof NotebookSessionProjectError)throw new OperationError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,false,'projects');throw e;}},
  async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string;project_id:string;session_id?:string;run_id?:string};if(out.space_id!==a.space_id)throw hidden();if(id==='project.notebook.chat')await new ProjectResearchAreaService(db,config).assertNotebookChatReceipt(person(a),out.project_id,out.run_id!,out.session_id!);if(id==='project.create')await assertProjectReadable(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);},
  async execute(db,raw,a){
   const i=raw as Input,body={...raw as Record<string,unknown>},p=person(a),repo=new PgProjectRepository(db),kernel=new ProjectKernelService(db),decisions=new DecisionCaseService(db);let row:Record<string,unknown>;
   for(const key of ['project_id','case_id','commitment_id','version_id','source_type','source_id'])delete body[key];
   switch(id){
    case 'project.public_summary.save':row=await repo.upsertPublicSummary(p,i.project_id,body);break;
    case 'project.public_summary.publish':row=await repo.publishPublicSummary(p,i.project_id,Number(body.draft_version));await enqueueRetrievalEmbeddingBackfillWithQueue(new PgJobQueueRepository(db),{spaceId:p.spaceId,userId:p.userId,trigger:'project_public_summary_publish'});break;
    case 'project.public_summary.revoke':await repo.revokePublicSummary(p,i.project_id);row={id:i.project_id};break;
    case 'project.update':row=await repo.update(p,i.project_id,body);break;
    case 'project.archive':row=await repo.archive(p,i.project_id);break;
    case 'project.notebook.chat':{const queued=await new ProjectResearchAreaService(db,config).notebookChat(p,i.project_id,body);return {id:queued.run_id,space_id:p.spaceId,project_id:i.project_id,session_id:queued.session_id,run_id:queued.run_id,job_id:queued.job_id,daily_limit:queued.daily_limit,daily_used:queued.daily_used};}
    case 'project.focus_area.set':await new FocusAreaService(db).setProjectFocusArea(p,i.project_id,i.focus_area_id??null);row={id:i.project_id};break;
    case 'project.update.report':row={id:(await reportProjectUpdate(db,p,i.project_id,String(body.summary))).id};break;
    case 'project.update.undo':await undoProjectUpdate(db,p,i.project_id,i.event_id!);row={id:i.event_id};break;
    case 'project.review_session.open':{
     const review=await new ProjectReviewSessionService(db).open(p,i.project_id,Number(body.limit)),sections=review.sections as {inquiry:{packet:{id:string|null}};knowledge:{packet:{id:string}}};
     return {id:sections.knowledge.packet.id,space_id:p.spaceId,project_id:i.project_id,inquiry_packet_id:sections.inquiry.packet.id,knowledge_packet_id:sections.knowledge.packet.id,created_at:review.created_at};
    }
    case 'project.create':row=await repo.create(p,body);break;
    case 'project.member.add':row=await repo.addMember(p,i.project_id,body);break;
    case 'project.member.remove':await repo.removeMember(p,i.project_id,i.user_id!);row={id:i.user_id};break;
    case 'project.brief.create':row=await kernel.createBriefVersion(p,i.project_id,body);break;
    case 'project.brief.submit_review':row=await kernel.submitBriefForReview(p,i.project_id,i.version_id!);break;
    case 'project.brief.publish':row=await kernel.publishBrief(p,i.project_id,i.version_id!);break;
    case 'project.instruction.create':row=await kernel.createInstructionVersion(p,i.project_id,body);break;
    case 'project.instruction.submit_review':row=await kernel.transitionInstruction(p,i.project_id,i.version_id!,false);break;
    case 'project.instruction.publish':row=await kernel.transitionInstruction(p,i.project_id,i.version_id!,true);break;
    case 'project.attention.set_state':await new ProjectAttentionService(db).setUserState(p,i.project_id,i.source_type!,i.source_id!,body);row={id:i.source_id};break;
    case 'decision.case.create':row=await decisions.createCase(p,i.project_id,body);break;
    case 'decision.option.add':row=await decisions.addOption(p,i.project_id,i.case_id!,body);break;
    case 'decision.criterion.add':row=await decisions.addCriterion(p,i.project_id,i.case_id!,body);break;
    case 'decision.option.score':row=await decisions.scoreOption(p,i.project_id,i.case_id!,body);break;
    case 'decision.case.decide':row=await decisions.decide(p,i.project_id,i.case_id!,body);break;
    case 'decision.commitment.add':row=await decisions.addCommitment(p,i.project_id,i.case_id!,body);break;
    case 'decision.commitment.deliver':{const result=await decisions.createDeliveryFromCommitment(p,i.project_id,i.case_id!,i.commitment_id!,body);row={id:(result.task as {id:string}).id};break;}
    default:throw new Error('Unregistered Project management command');
   }
   return {id:row.id,space_id:p.spaceId,project_id:id==='project.create'?row.id:i.project_id};
  },
  classifyError(e){if(e instanceof NotebookChatBudgetError)return new OperationError('operation_limit_exceeded',429,false,'projectResearch');if(e instanceof ProjectArchivedMutationError||e instanceof ProjectManagementMutationError||e instanceof DecisionMutationError||e instanceof FocusAreaArchivedError||e instanceof ProjectUpdateUndoError||e instanceof InquiryMutationError||e instanceof NotebookChatMutationError||e instanceof NotebookSessionProjectError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'projects');return undefined;},
 }));
}
