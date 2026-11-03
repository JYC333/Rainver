import type {Queryable} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import {digestTimezone} from '../digestPeriod.js';
import {localDateFromSlot} from '../../scheduler/localDay.js';
import type {EditionDay} from './types.js';

export async function projectReadingDay(db:Queryable,spaceId:string,projectId:string,slot=new Date().toISOString()):Promise<EditionDay>{
 const timezone=await digestTimezone(db,spaceId,{type:'project',projectId});
 return {date:localDateFromSlot(slot,timezone),timezone};
}
export function assertEditionDate(date:string){
 const parsed=new Date(`${date}T00:00:00Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)throw new HttpError(422,'Invalid edition date');
}
