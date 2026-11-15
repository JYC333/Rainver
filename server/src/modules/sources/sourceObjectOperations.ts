import type {OperationActor,OperationInput,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {SOURCE_OBJECT_SCHEMAS,SOURCE_RETENTION_REFUSAL_CODE,SourceRetentionRefusalMetadataSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {OperationError,OperationRefusal,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {PgSourcesRepository} from './repository.js';
import {SourceObjectRefusal} from './sourceObjectErrors.js';
import {SourceRetentionRefusal} from './sourceConsent.js';

type Id=keyof typeof SOURCE_OBJECT_SCHEMAS;
type In<T extends Id>=OperationInput<T>&Record<string,unknown>;
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
type Bound={item:string|null;evidence:string|null;connection:string|null;artifact:string|null;project:string|null};
type Scope=ResolvedOperation&{bound:Bound};

/** Stable targets discovered before key admission; rechecked under locks. */
async function discover(db:Queryable,config:ServerConfig,id:Id,raw:Record<string,unknown>,actor:OperationActor):Promise<Bound>{
  const repo=new PgSourcesRepository(db,config),p=person(actor);
  const bound:Bound={item:null,evidence:null,connection:null,artifact:null,project:(raw.project_id as string|null|undefined)??null};
  if(typeof raw.source_item_id==='string'){bound.item=raw.source_item_id;await repo.requireItemControl(p,bound.item,{lock:false,full:true});}
  if(typeof raw.evidence_id==='string'){bound.evidence=raw.evidence_id;await repo.requireEvidenceControl(p,bound.evidence,id==='source.evidence.update',false);}
  if(typeof raw.artifact_id==='string'){bound.artifact=raw.artifact_id;if(await contentDecisionFromDb(db,p,'artifact',bound.artifact)!=='full')throw hidden();}
  if(typeof raw.connection_id==='string'&&id==='source.item.save_url'){
    const row=(await db.query<{id:string;project_id:string|null}>('SELECT id,project_id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[raw.connection_id,actor.space_id])).rows[0];
    if(!row)throw hidden();bound.connection=row.id;
    // A Project connection files into its own Project; restating it is allowed, naming another is not.
    // A connection without a Project may file into a Project the caller writes (checked under lock).
    // Consistency with the connection's own Project is decided after authorization (execute).
    if(row.project_id)bound.project=null;
  }
  // The source decides evidence placement, exactly as before; a project_id may only restate it (execute).
  if(id==='source.evidence.create'&&(bound.item||bound.artifact))bound.project=null;
  return bound;
}
function authority(id:Id,bound:Bound,actor:OperationActor):string{
  if(bound.evidence)return `extracted_evidence:${bound.evidence}`;
  if(bound.item)return `source_item:${bound.item}`;
  if(bound.artifact)return `artifact:${bound.artifact}`;
  if(bound.connection)return `source_connection:${bound.connection}`;
  if(bound.project)return `project:${bound.project}`;
  return `${id==='source.item.save_url'?'source_items':'extracted_evidence'}:${actor.space_id}`;
}

export function sourceObjectRegistrations(config:ServerConfig,definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
  const repository=(db:Queryable)=>new PgSourcesRepository(db,config);
  return (Object.keys(SOURCE_OBJECT_SCHEMAS) as Id[]).map(id=>({
    definition:definitions.get(id)!,
    // New items/evidence without a source are placed by the access owner, exactly as the retained REST adapters always did.
    ...(id==='source.item.save_url'||id==='source.evidence.create'?{userContentCreation:true as const}:{}),
    successStatus:id==='source.item.save_url'||id==='source.evidence.create'||id==='source.evidence.link'?201:200,
    async resolve(db,raw,actor){
      const bound=await discover(db,config,id,raw as Record<string,unknown>,actor);
      return {authority:authority(id,bound,actor),targets:bound,resourceType:id.startsWith('source.evidence')?'evidence':'source_item',resourceId:bound.evidence??bound.item,bound} as Scope;
    },
    async authorize(db,raw,actor,scope){
      const bound=(scope as Scope).bound,p=person(actor),repo=repository(db);
      // Project authority first, then the object row, then the same gate again.
      if(bound.project)await assertProjectWriterForMutation(db,actor.space_id,bound.project,p.userId);
      if(bound.connection)await db.query('SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 FOR SHARE',[bound.connection,actor.space_id]);
      if(bound.item)await repo.requireItemControl(p,bound.item,{lock:true,full:true});
      if(bound.evidence)await repo.requireEvidenceControl(p,bound.evidence,id==='source.evidence.update',true);
      if(canonical(await discover(db,config,id,raw as Record<string,unknown>,actor))!==canonical(bound))throw new OperationError('operation_conflict',409);
    },
    async execute(db,raw,actor){
      const repo=repository(db),p=person(actor);
      if(id==='source.item.save_url'){const input=raw as In<'source.item.save_url'>;// Without a connection the access owner's placement decides visibility: shared in a Project, private in Personal.
        if(input.connection_id&&input.project_id){const own=(await db.query<{project_id:string|null}>('SELECT project_id FROM source_connections WHERE id=$1 AND space_id=$2',[input.connection_id,actor.space_id])).rows[0]?.project_id;if(own&&own!==input.project_id)throw new SourceObjectRefusal(422,'This Source belongs to a different Project');}
        const item=await repo.createManualUrl(p,{url:input.url,title:input.title,project_id:input.project_id,connection_id:input.connection_id,queue_content:input.queue_content,...(input.connection_id?{}:{visibility:input.project_id?'space_shared':'private'})});return {id:item.id,space_id:actor.space_id};}
      if(id==='source.item.update'){const input=raw as In<'source.item.update'>;await repo.updateItem(p,input.source_item_id,{connection_id:input.connection_id});return {id:input.source_item_id,space_id:actor.space_id};}
      if(id==='source.item.queue'||id==='source.item.triage'){const input=raw as In<'source.item.queue'>;await repo.itemAction(p,input.source_item_id,{action:input.action});return {id:input.source_item_id,space_id:actor.space_id};}
      if(id==='source.evidence.create'){const input=raw as In<'source.evidence.create'>;
        if(input.project_id&&(input.source_item_id||input.artifact_id)){const derived=input.source_item_id?(await repo.requireItemControl(p,input.source_item_id,{lock:false,full:true})).project_id:(await db.query<{project_id:string|null}>('SELECT project_id FROM artifacts WHERE id=$1 AND space_id=$2',[input.artifact_id,actor.space_id])).rows[0]?.project_id??null;if(derived!==input.project_id)throw new SourceObjectRefusal(422,'Evidence sources must use the same Project context');}const row=await repo.createEvidence(p,{...input,metadata:input.metadata??undefined});return {id:row.id,space_id:actor.space_id};}
      if(id==='source.evidence.update'){const {evidence_id,...changes}=raw as In<'source.evidence.update'>;await repo.updateEvidence(p,evidence_id,changes);return {id:evidence_id,space_id:actor.space_id};}
      const input=raw as In<'source.evidence.link'>;
      const link=await repo.createEvidenceLink(p,input);
      return {id:link.id,space_id:actor.space_id,evidence_id:input.evidence_id};
    },
    /** Every result and every replay is released only under the caller's current reach. */
    async authorizeResult(db,raw,actor){
      const out=raw as {id:string;space_id:string;evidence_id?:string};
      if(out.space_id!==actor.space_id)throw hidden();
      const repo=repository(db),p=person(actor);
      if(id==='source.evidence.link')await repo.requireEvidenceLinkReach(p,out.id,out.evidence_id!);
      else if(id.startsWith('source.evidence'))await repo.requireEvidenceControl(p,out.id,id==='source.evidence.update',false);
      else await repo.requireItemControl(p,out.id,{lock:false,full:id!=='source.item.save_url'});
    },
    classifyError(error){
      if(error instanceof SourceObjectRefusal)return new OperationRefusal(error.statusCode as 409|422,'sources',error.message);
      // A consent refusal names only the retention level the Source forbids.
      if(error instanceof SourceRetentionRefusal)return new OperationRefusal(409,'sources',error.message,SourceRetentionRefusalMetadataSchema.parse({code:SOURCE_RETENTION_REFUSAL_CODE,requested:error.requested}));
      return undefined;
    },
  }));
}
