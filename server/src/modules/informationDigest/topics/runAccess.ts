import type {Queryable} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import type {RunRecord} from '../../runs/repository.js';
import {PgBriefingRepository} from '../briefing/repository.js';
import {briefingRunContext,adapterForRow} from '../briefing/settlement.js';
import {authorizeVersion} from '../briefing/authorization.js';
import {goalOfKey} from './scope.js';

/** Raw Run prompts and output have the whole version's dependencies, not just
 * the visible overview's citations. A generic detail/list must not bypass them.
 * Historical reads check authority, never mutable execution freshness. */
export async function themeRunReadable(db:Queryable,run:RunRecord,viewer:string):Promise<boolean>{
 const context=briefingRunContext(run);if(!context||!goalOfKey(context.scope_key))return false;
 const repository=new PgBriefingRepository(db),row=await repository.get(run.space_id,context.id);
 if(!row||row.scope_key!==context.scope_key)return false;
 const adapter=adapterForRow(row);
 if(!await adapter.canRead(db,viewer))return false;
 try{
  const authority=await authorizeVersion(db,adapter,{...row,run_id:run.id},await repository.inputs(row.id));
  return authority.refs.length>0&&authority.refs.every(ref=>authority.allowed.has(ref));
 }catch(error){if(error instanceof HttpError&&[403,404,409,422].includes(error.statusCode))return false;throw error;}
}
