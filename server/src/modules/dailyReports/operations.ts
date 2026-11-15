import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError,type Queryable} from '../routeUtils/common.js';
import {lockActivePerson} from '../access/activePerson.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgDailyReportSettingsRepository} from './repository.js';
async function owner(db:Queryable,a:OperationActor){
 if(!a.on_behalf_of_user_id)throw hidden();
 await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id);
 await db.query('SELECT id FROM spaces WHERE id=$1 FOR SHARE',[a.space_id]);
}
export function dailyCaptureSettingsRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (['daily_capture.settings.patch','daily_capture.settings.set'] as const).map(id=>({
  definition:defs.get(id)!,
  async resolve(_db,_raw,a){return {authority:`daily-capture-settings:${a.space_id}:${a.on_behalf_of_user_id}`,targets:{space_id:a.space_id,user_id:a.on_behalf_of_user_id},resourceType:'space',resourceId:a.space_id};},
  async authorize(db,_raw,a){await owner(db,a);},
  async authorizeResult(db,raw,a){const out=raw as {space_id:string;user_id:string};if(out.space_id!==a.space_id||out.user_id!==a.on_behalf_of_user_id)throw hidden();await owner(db,a);},
  async execute(db,raw,a){const repo=new PgDailyReportSettingsRepository(db);return repo.toOut(await repo.update(a.space_id,a.on_behalf_of_user_id!,raw as Record<string,unknown>));},
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'dailyReports'):undefined,
 }));
}
