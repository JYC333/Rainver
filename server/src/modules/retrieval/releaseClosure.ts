import {reportReleasePlans} from "./reportReleasePlan.js";
import type {RetrievalObjectType} from '@rainver/protocol';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease,lockSourceRetrievalReleaseBatch,sourceRetrievalReleaseProjects} from '../sources/retrievalReleaseLocks.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {canonical} from '../systemActions/operations/repository.js';
import type {RetrievalRegistry} from './registry.js';

export type ReleaseRef={object_type:RetrievalObjectType;object_id:string};
/** Refs owned by one retrieval registry; one release may span several. */
export interface ReleaseGroup{registry:RetrievalRegistry;refs:readonly ReleaseRef[]}
type SourceRef=Parameters<typeof lockSourceRetrievalRelease>[3][number];
/** Rows pinned after the shared Source closure (Projects, person, Space,
 * folders, roots, grants, channels): `extension` rows (sorted by key), then
 * `lineage` rows. See `lockRetrievalReleaseClosure` for the writer contract. */
type RowLock={key:string;phase:'extension'|'lineage';sql:string;params:unknown[]};
type Lineage={sourceRefs:SourceRef[];projects:string[];locks:RowLock[];fingerprint:unknown};

const EXTENSION_TABLE:Partial<Record<string,string>>={knowledge_item:'knowledge_items',note:'notes',claim:'claims',source:'sources'};
const PROVENANCE_TARGET:Partial<Record<string,string>>={knowledge_item:'knowledge',note:'note',memory_entry:'memory'};
const rowLock=(table:string,column:string,id:string):RowLock=>({key:`${table}:${id}`,phase:'extension',sql:`SELECT ${column} FROM ${table} WHERE space_id=$1 AND ${column}=$2 FOR SHARE`,params:[id]});

/** The canonical content resource whose decision must be `full` before a
 * derived body may be released: a Thread's or Knowledge object's ontology
 * root, a Memory entry. Source rows are full-only in their adapter, and a
 * Project public summary is a reviewed Space-wide publication whose gate is
 * its live publication, active Project and Source policy. */
export function releaseRootResource(type:RetrievalObjectType):'space_object'|'memory'|null{
 if(type==='memory_entry')return 'memory';
 if(type==='source_item'||type==='extracted_evidence'||type==='project_public_summary')return null;
 return 'space_object';
}

/** The read dependencies each domain's adapter and release gate rest on. */
async function discoverLineage(db:Queryable,space:string,registry:RetrievalRegistry,ref:ReleaseRef):Promise<Lineage>{
 const {object_type:type,object_id:id}=ref;
 if(type==='source_item'||type==='extracted_evidence')return {sourceRefs:[ref],projects:[],locks:[],fingerprint:null};
 if(type==='inquiry_thread'){
  const row=(await db.query<{project_id:string;lifecycle_status:string}>('SELECT project_id,lifecycle_status FROM inquiry_threads WHERE space_id=$1 AND object_id=$2',[space,id])).rows[0]??null;
  return {sourceRefs:[{object_type:'space_object',object_id:id}],projects:row?[row.project_id]:[],locks:[rowLock('inquiry_threads','object_id',id)],fingerprint:row};
 }
 if(type==='project_public_summary'){
  const object=await registry.adapterFor(type)?.loadCanonical(db,space,type,id);
  const published=(await db.query<{published_at:unknown}>('SELECT published_at FROM project_public_summary_publications WHERE space_id=$1 AND project_id=$2',[space,id])).rows[0]??null;
  const connections=object?.sourceConnectionIds.slice().sort()??[];
  return {sourceRefs:connections.map(c=>({object_type:'source_connection' as const,object_id:c})),projects:[id],locks:[rowLock('project_public_summary_publications','project_id',id)],fingerprint:{connections,published:published?String(published.published_at):null,active:Boolean(object)}};
 }
 // Knowledge and Memory: root, extension row, accepted provenance and claim sources.
 const object=await registry.adapterFor(type)?.loadCanonical(db,space,type,id);
 const target=PROVENANCE_TARGET[type];
 const provenance=target?(await db.query<{source_type:string;source_id:string}>('SELECT source_type,source_id FROM provenance_links WHERE space_id=$1 AND target_type=$2 AND target_id=$3 ORDER BY source_type,source_id',[space,target,id])).rows:[];
 const claimSources=type==='claim'?(await db.query<{source_object_id:string|null}>('SELECT source_object_id FROM claim_sources WHERE space_id=$1 AND claim_id=$2 ORDER BY id',[space,id])).rows:[];
 const connections=object?.sourceConnectionIds.slice().sort()??[];
 const claimRoots=claimSources.flatMap(c=>c.source_object_id?[c.source_object_id]:[]);
 const extension=EXTENSION_TABLE[type];
 return {
  sourceRefs:[{object_type:type==='memory_entry'?'memory':'space_object',object_id:id},...connections.map(c=>({object_type:'source_connection' as const,object_id:c})),
   ...provenance.filter(p=>['source_item','source_snapshot','extracted_evidence'].includes(p.source_type)).map(p=>({object_type:p.source_type as 'source_item',object_id:p.source_id})),
   ...claimRoots.map(c=>({object_type:'space_object' as const,object_id:c}))],
  projects:[],
  locks:[...(extension?[rowLock(extension,'object_id',id)]:[]),...claimRoots.map(c=>rowLock('sources','object_id',c)),
   ...(target?[{key:`provenance_links:${target}:${id}`,phase:'lineage' as const,sql:'SELECT id FROM provenance_links WHERE space_id=$1 AND target_type=$2 AND target_id=$3 ORDER BY id FOR SHARE',params:[target,id]}]:[]),
   ...(type==='claim'?[{key:`claim_sources:${id}`,phase:'lineage' as const,sql:'SELECT id FROM claim_sources WHERE space_id=$1 AND claim_id=$2 ORDER BY id FOR SHARE',params:[id]}]:[])],
  fingerprint:{connections,provenance,claimSources},
 };
}

/** Pin the complete current read closure of every ref in every group, once,
 * in ONE global order (all FOR SHARE):
 *
 *  1. Project audiences, sorted.
 *  2. Person, Space, folders, every Source/ontology/Memory root with its
 *     shares and grants, Source channels/subscriptions/windows (the shared
 *     Source closure, `lockSourceRetrievalRelease`).
 *  3. Extension rows of every domain, sorted by key: `notes`,
 *     `knowledge_items`, `claims`, `sources`, `inquiry_threads`,
 *     `project_public_summary_publications`.
 *  4. Accepted provenance and claim-source rows.
 *
 * Writer contract (a waits-for cycle needs a writer that X-locks two of these
 * rows in the opposite order; S/S never conflicts):
 *  - Root then extension — Note `writeNote`/body save and rollback
 *    (`noteRevisionService`), Note metadata CTE, project-role assignment,
 *    capture relocation; Knowledge update/archive and Claim update/archive
 *    (`lockMutationRoots`, then extension, then `claim_sources`); Source object
 *    update CTE; Inquiry operation admission (roots, then `inquiry_threads`).
 *    These follow 2 → 3 → 4 directly.
 *  - Extension then root — only the Inquiry Thread services (iteration,
 *    thread tree, problem facts, research pin). Each first takes the Thread's
 *    Project `FOR UPDATE` (`lockActiveProjectForMutation`), which conflicts
 *    with step 1's `FOR SHARE`, so a closure and such a writer serialize on the
 *    Project before either touches the Thread or its root.
 *  - Publication publish/revoke X-lock only the publication row here.
 *
 * Any mix of Note/Knowledge/Inquiry/Source/Project contributions therefore
 * takes one acyclic order. Discovery is authority-free; a lineage that changed
 * while waiting is a 409, never a second, unsorted closure. */
export async function lockRetrievalReleaseClosure(db:Queryable,space:string,user:string,groups:readonly ReleaseGroup[],additional:readonly SourceRef[]=[],additionalProjects:readonly string[]=[],artifactRoots:readonly string[]=[]):Promise<void>{
 await lockRetrievalReleaseBatch(db,[{space,user,groups,additional,additionalProjects,artifactRoots}]);
}

export interface RetrievalReleaseScope {
 space:string; user:string; groups:readonly ReleaseGroup[]; allowInactiveViewer?:true;
 additional?:readonly SourceRef[]; additionalProjects?:readonly string[]; artifactRoots?:readonly string[]; artifactBatch?:true;
}
/** Cross-Space callers discover all lineage before any lock; the canonical
 * Source owner pins its phases globally, then all extensions and lineage. */
export async function lockRetrievalReleaseBatch(db:Queryable,scopes:readonly RetrievalReleaseScope[]):Promise<void>{
 const plans=[];
 const held=reportReleasePlans.get(db);
 if(held){
  const normalize=(type:string)=>type==='memory_entry'?'memory':['knowledge_item','note','claim','source','inquiry_thread'].includes(type)?'space_object':type;
  for(const scope of scopes){
   const refs=[...scope.groups.flatMap(g=>g.refs),...(scope.additional??[]),...(scope.artifactRoots??[]).map(id=>({object_type:"artifact",object_id:id}))];
   if(scope.additionalProjects?.length||refs.some(r=>!held.has(r.object_type+":"+r.object_id)&&!held.has(normalize(r.object_type)+":"+r.object_id)))throw new HttpError(409,"Report inputs changed; run again");
  }
  return;
 }
 for(const {space,user,groups,allowInactiveViewer,additional=[],additionalProjects=[],artifactRoots=[],artifactBatch} of [...scopes].sort((a,b)=>a.space.localeCompare(b.space))){
  const sorted=uniqueGroups(groups).map(g=>({...g,refs:[...g.refs].sort((a,b)=>(a.object_type+':'+a.object_id).localeCompare(b.object_type+':'+b.object_id))}));
  const discover=async()=>{const out:Lineage[]=[];for(const g of sorted)for(const r of g.refs)out.push(await discoverLineage(db,space,g.registry,r));return out;};
  const artifactPlan=artifactRoots.length?await (await import("../contentAccess/demotionReleaseClosure.js")).prepareArtifactReleaseClosure(db,{spaceId:space,userId:user},artifactRoots,undefined,artifactBatch):null;
  const before=await discover();
  const locks=[...new Map(before.flatMap(l=>l.locks).map(l=>[l.key,l])).values()].sort((a,b)=>a.key.localeCompare(b.key));
  plans.push({space,user,allowInactiveViewer,additional,additionalProjects,discover,before,locks,artifactPlan});
 }
 await lockSourceRetrievalReleaseBatch(db,plans.map(p=>({spaceId:p.space,userId:p.user,allowInactiveViewer:p.allowInactiveViewer,refs:[...p.before.flatMap(l=>l.sourceRefs),...p.additional,...(p.artifactPlan?.refs??[])],additionalProjects:[...new Set([...p.additionalProjects,...p.before.flatMap(l=>l.projects),...(p.artifactPlan?.projects??[])])].sort(),additionalFolders:p.artifactPlan?.folders,beforeContent:p.artifactPlan?.beforeContent})));
 for(const p of plans)await p.artifactPlan?.afterContent();
 for(const phase of ['extension','lineage'] as const)for(const p of plans)for(const l of p.locks)if(l.phase===phase)await db.query(l.sql,[p.space,...l.params]);
 for(const p of plans)if(canonical(p.before.map(l=>l.fingerprint))!==canonical((await p.discover()).map(l=>l.fingerprint)))throw new HttpError(409,'Retrieval lineage changed; read again');
}

/** The Projects `withheldReleaseRefs` locks for these groups, discovered without
 * locks, for a caller that takes them before a lock it already holds (the
 * Runtime Context preview release takes them before its Run). */
export async function retrievalReleaseProjects(db:Queryable,space:string,groups:readonly ReleaseGroup[]):Promise<string[]>{
 const lineage:Lineage[]=[];
 for(const g of uniqueGroups(groups))for(const r of g.refs)lineage.push(await discoverLineage(db,space,g.registry,r));
 return sourceRetrievalReleaseProjects(db,space,lineage.flatMap(l=>l.sourceRefs),[...new Set(lineage.flatMap(l=>l.projects))].sort());
}

const uniqueGroups=(groups:readonly ReleaseGroup[])=>groups.map(g=>({registry:g.registry,refs:[...new Map(g.refs.map(r=>[r.object_type+':'+r.object_id,r])).values()]})).filter(g=>g.refs.length);

/** The one current-audience check for a released or persisted retrieval
 * result, in the caller's transaction: pins the shared closure, then runs
 * `withheldPinnedReleaseRefs`. Returns how many refs are not releasable. */
export async function withheldReleaseRefs(tx:Queryable,identity:SpaceUserIdentity,groups:readonly ReleaseGroup[],auditReason:string|null,options:{rawMemory?:boolean}={}):Promise<number>{
 const unique=uniqueGroups(groups);
 await lockRetrievalReleaseClosure(tx,identity.spaceId,identity.userId,unique);
 return withheldPinnedReleaseRefs(tx,identity,unique,auditReason,options);
}

/** The release decision once the caller has pinned the closure of `groups`
 * (`lockRetrievalReleaseClosure`) in this transaction. Every ref needs: its
 * canonical root decision `full` (a Thread or Knowledge root's summary is not
 * its full content), its adapter's current read, and the search release gate
 * `revalidateForRelease` — canonical Source lineage and `sourcePolicyAllowsRead`
 * (consent, archive, owner) for the viewer. `canonical` runs that gate over
 * the canonical lineage without requiring a projection row (stored reports);
 * it records no read, so it requires `auditReason` null. Returns how many refs
 * are not releasable; a partially withheld result records no read. */
export async function withheldPinnedReleaseRefs(tx:Queryable,identity:SpaceUserIdentity,groups:readonly ReleaseGroup[],auditReason:string|null,options:{rawMemory?:boolean;canonical?:boolean}={}):Promise<number>{
 if(options.canonical&&auditReason!==null)throw new Error('canonical release checks record no read');
 const unique=uniqueGroups(groups);
 let withheld=0;
 for(const g of unique)for(const ref of g.refs){
  const root=releaseRootResource(ref.object_type);
  if(root&&await contentDecisionFromDb(tx,identity,root,ref.object_id)!=='full'){withheld++;continue;}
  if(!options.rawMemory){const current=await g.registry.adapterFor(ref.object_type)?.revalidate(tx,identity.spaceId,ref.object_type,ref.object_id,identity.userId);if(!current||current.text===null)withheld++;}
 }
 if(withheld||options.rawMemory)return withheld;
 const {RetrievalSearchService}=await import('./searchService.js');
 const viewer={spaceId:identity.spaceId,viewerUserId:identity.userId};
 for(const g of unique){const search=new RetrievalSearchService(tx,g.registry);const allowed=options.canonical?await search.revalidateCanonicalForRelease(viewer,g.refs):await search.revalidateForRelease(viewer,g.refs,null);withheld+=g.refs.filter(r=>!allowed.has(r.object_type+':'+r.object_id)).length;}
 if(withheld||auditReason===null)return withheld;
 for(const g of unique)await new RetrievalSearchService(tx,g.registry).revalidateForRelease(viewer,g.refs,auditReason);
 return 0;
}
