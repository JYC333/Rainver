import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {lockReadingMutations} from '../../sources/readingMutationAccess.js';
import {ReadingPreferences} from '../readingPreferences.js';
import {PgBriefingRepository} from './repository.js';
import {comparisonClosure,inputDeps,type ComparisonEntry} from './authorization.js';
import {canonical} from '../../systemActions/operations/repository.js';
import {scopedBriefing,authorizedHighlight} from './highlight.js';
import type {BriefingScopeAdapter} from './contract.js';

/** Exact frozen-version closure for an adoption, discovered before the shared
 * Project/person/Space/Folder/root phases. No late per-item lock expansion. */
export async function lockHighlightAdoption(db:Queryable,identity:SpaceUserIdentity,adapter:BriefingScopeAdapter,id:string,index:number){
 const repo=new PgBriefingRepository(db);
 const discover=async()=>{
  const row=await scopedBriefing(db,adapter,id,identity.userId),inputs=await repo.inputs(id);
  const comparison=comparisonClosure((row.comparison_json??[]) as ComparisonEntry[]);
  const deps=[...inputs.filter(i=>i.ref_kind==='source_item'&&i.source_item_id).map(inputDeps),comparison.deps];
  const context=[...row.context_json.map(c=>c.source),...comparison.context];
  const projects=adapter.scope.projectId?[adapter.scope.projectId]:await new ReadingPreferences(db).enabled(identity);
  const readableProjects=adapter.scope.projectId?projects:await new ReadingPreferences(db).readableEnabled(identity);
  return {row,inputs,deps,context,projects:projects.sort(),readableProjects};
 };
 const before=await discover();
 const items=[...new Set(before.deps.flatMap(d=>d.items.map(i=>i.id)))].sort();
 const connections=[...new Set(before.deps.flatMap(d=>[...d.items,...d.annotations,...d.signals].flatMap(i=>i.connection_id?[i.connection_id]:[])))].sort();
 await lockReadingMutations(db,identity,items,adapter.scope.projectId?before.projects:[],[
  ...(before.row.run_id?[{object_type:'run' as const,object_id:before.row.run_id}]:[]),
  ...connections.map(id=>({object_type:'source_connection' as const,object_id:id})),
  ...before.context.filter(c=>c.type==='task').map(c=>({object_type:'task' as const,object_id:c.id})),
  ...before.deps.flatMap(d=>d.items.flatMap(i=>i.original?[{object_type:'source_snapshot' as const,object_id:i.original.snapshot_id},{object_type:'artifact' as const,object_id:i.original.artifact_id}]:[])),
 ],[],[],adapter.scope.projectId?[adapter.scope.projectId]:[],adapter.scope.projectId?[]:before.projects);
 const goals=[...new Set(before.context.filter(c=>c.type==='goal').map(c=>c.id))].sort();
 if(goals.length)await db.query('SELECT id FROM source_goals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[identity.spaceId,goals]);
 if(items.length)for(const table of ['source_item_annotations','source_post_processing_item_decisions'] as const)await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[identity.spaceId,items]);
 await db.query('SELECT id FROM information_briefings WHERE space_id=$1 AND id=$2 FOR SHARE',[identity.spaceId,id]);
 await db.query('SELECT id FROM information_briefing_inputs WHERE briefing_id=$1 ORDER BY id FOR SHARE',[id]);
 if(canonical(before)!==canonical(await discover()))throw new HttpError(409,'Briefing dependencies changed',{code:'briefing_changed'});
 return authorizedHighlight(db,adapter,id,index,identity.userId);
}
