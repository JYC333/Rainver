import {HttpError,type Queryable} from '../../routeUtils/common.js';
import {lockReadingMutations} from '../../sources/readingMutationAccess.js';
import {ReadingPreferences} from '../readingPreferences.js';
import {personalBriefingScope} from './personalScope.js';
import {comparisonClosure,inputDeps,type ComparisonEntry} from './authorization.js';
import {PgBriefingRepository} from './repository.js';
import {selectExecution,type BriefingExecution} from './execution.js';
import {canonical} from '../../systemActions/operations/repository.js';

/** Authority-free scope discovery precedes the shared Project/person/Space/
 * Folder/Source lock phases. Include old comparison/carry dependencies, not
 * just today's selectable items. No model work takes place here. */
export async function lockPersonalBriefingRequest(db:Queryable,space:string,user:string,requested:Partial<BriefingExecution>){
  const adapter=personalBriefingScope(space,user),repo=new PgBriefingRepository(db);
  const cutoff=new Date().toISOString();
  const discover=async()=>{
    const candidates=await adapter.candidates(db,{since:'0001-01-01T00:00:00.000Z',cutoff,pinnedItemIds:[]});
    const context=await adapter.context(db);
    const history=(await db.query<{id:string}>(`SELECT id FROM information_briefings WHERE space_id=$1 AND scope_key=$2 ORDER BY id`,[space,adapter.scope.key])).rows;
    const deps=[];
    const historicalContext=[];
    for(const {id} of history){
      const row=(await repo.get(space,id))!;
      historicalContext.push(...row.context_json.map(c=>c.source),...comparisonClosure((row.comparison_json??[]) as ComparisonEntry[]).context);
      deps.push(...(await repo.inputs(id)).filter(i=>i.ref_kind==='source_item'&&i.source_item_id).map(inputDeps),comparisonClosure((row.comparison_json??[]) as ComparisonEntry[]).deps);
    }
    const projects=await new ReadingPreferences(db).enabled({spaceId:space,userId:user});
    const readableProjects=await new ReadingPreferences(db).readableEnabled({spaceId:space,userId:user});
    return {candidates,context,historicalContext,history,projects:projects.sort(),readableProjects,deps};
  };
  const before=await discover(),execution=await selectExecution(db,space,user,requested);
  const items=[...new Set([...before.candidates.rows.map(r=>r.source_item_id),...before.candidates.not_shared_ids,...before.deps.flatMap(d=>d.items.map(i=>i.id))])].sort();
  const connections=[...new Set([...before.candidates.rows.flatMap(r=>[r.connection_id,...r.signals.map(s=>s.dep.connection_id)]),...before.deps.flatMap(d=>[...d.items,...d.annotations,...d.signals].map(i=>i.connection_id))].filter((id):id is string=>!!id))].sort();
  await lockReadingMutations(db,{spaceId:space,userId:user},items,[],[{object_type:'agent',object_id:execution.agent_id},...connections.map(id=>({object_type:'source_connection' as const,object_id:id})),...before.deps.flatMap(d=>d.items.flatMap(i=>i.original?[{object_type:'source_snapshot' as const,object_id:i.original.snapshot_id},{object_type:'artifact' as const,object_id:i.original.artifact_id}]:[]))],[],[],[],before.projects);
  // Content roots are already pinned. Freeze the remaining analysis/signal
  // owners before reselecting, in the same domain phase as Reading mutations.
  const goals=[...new Set([...before.context.map(c=>c.source),...before.historicalContext].filter(c=>c.type==='goal').map(c=>c.id))].sort();
  if(goals.length)await db.query('SELECT id FROM source_goals WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[space,goals]);
  if(items.length){
    for(const table of ['source_item_annotations','source_channel_item_links','source_post_processing_item_decisions'] as const)await db.query(`SELECT id FROM ${table} WHERE space_id=$1 AND source_item_id=ANY($2::varchar[]) ORDER BY id FOR SHARE`,[space,items]);
  }
  if(before.history.length){
    await db.query('SELECT id FROM information_briefings WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[space,before.history.map(r=>r.id)]);
    await db.query('SELECT id FROM information_briefing_inputs WHERE briefing_id=ANY($1::varchar[]) ORDER BY id FOR SHARE',[before.history.map(r=>r.id)]);
  }
  await selectExecution(db,space,user,execution,true);
  const recheck=async()=>{
    const current=await discover();
    // Creating this command's own version changes history. Only admission's
    // existing dependencies and candidate/context selection must remain fixed.
    if(canonical({candidates:before.candidates,context:before.context,projects:before.projects,readableProjects:before.readableProjects})!==canonical({candidates:current.candidates,context:current.context,projects:current.projects,readableProjects:current.readableProjects}))throw new HttpError(409,'Briefing inputs changed',{code:'briefing_changed'});
  };
  const locked=await discover();
  if(canonical({history:before.history,deps:before.deps,context:before.historicalContext})!==canonical({history:locked.history,deps:locked.deps,context:locked.historicalContext}))throw new HttpError(409,'Briefing history changed',{code:'briefing_changed'});
  await recheck();
  return {recheck,execution};
}
