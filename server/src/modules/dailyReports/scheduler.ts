import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import {HttpError} from '../routeUtils/common.js';
import {requestDailyReport} from "./runOperation.js";
import {enforce} from "../policy/service.js";
import {loadActionRegistry} from "../policy/actionRegistry.js";
import { wakeJobWorkers } from "../jobs/wakeSignal.js";
import { isValidTimezone, reportDateForSlot } from "../scheduler/localDay.js";
import { PgDailyReportSettingsRepository, type DailyReportSettingRow } from "./repository.js";

export async function scanDailyReportsAndEnqueue(config: ServerConfig): Promise<number> {
  if (!config.databaseUrl) return 0;
  const db = getDbPool(config.databaseUrl);
  const repo = new PgDailyReportSettingsRepository(db);
  const nowIso = new Date().toISOString();
  const due = await repo.listDue(nowIso);
  let count = 0;
  for (const setting of due) {
    const slotUtc = setting.next_run_at ?? nowIso;
    const payload = buildDailyReportJobPayload(setting, slotUtc);
    if (!payload) continue;
    try {
      const queued=await withTransaction(db, async (tx) => {
        // Roll back only admission on a business refusal. Its safe outcome and
        // the slot advance must still commit; SQL/audit failures retry the slot.
        await tx.query('SAVEPOINT daily_schedule_admission');
        let outcome:{status:string;http_status?:number}={status:'admitted'};
        let queued=false;
        try {
          const result=await requestDailyReport(tx,setting.space_id,setting.user_id,{local_date:String(payload.local_date)},'automation');
          queued=result.status!=='completed';
        } catch(error) {
          if(!(error instanceof HttpError)||error.statusCode<400||error.statusCode>=500)throw error;
          await tx.query('ROLLBACK TO SAVEPOINT daily_schedule_admission');
          outcome={status:'refused',http_status:error.statusCode};
        }
        const decision=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'daily_capture.run',force_record:true,actor_type:'user',actor_id:setting.user_id,space_id:setting.space_id,resource_space_id:setting.space_id,resource_type:'space',resource_id:setting.space_id});
        if(decision.status==='error'||!decision.policy_decision_record_id)throw new Error('Daily report schedule audit unavailable');
        if(decision.status!=='allow'){
          await tx.query('ROLLBACK TO SAVEPOINT daily_schedule_admission');
          // Re-record policy after rollback, before committing the refusal.
          const refused=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'daily_capture.run',force_record:true,actor_type:'user',actor_id:setting.user_id,space_id:setting.space_id,resource_space_id:setting.space_id,resource_type:'space',resource_id:setting.space_id});
          if(refused.status==='error'||!refused.policy_decision_record_id)throw new Error('Daily report refusal audit unavailable');
          outcome={status:'refused',http_status:403};queued=false;
        }
        await tx.query('RELEASE SAVEPOINT daily_schedule_admission');
        await new PgDailyReportSettingsRepository(tx).advanceNextRun(setting, slotUtc, outcome);
        return queued;
      });
      if(queued){wakeJobWorkers();count += 1;}
    } catch {
      // Infrastructure/audit failure rolled back everything; retry this slot.
    }
  }
  return count;
}

export function buildDailyReportJobPayload(
  setting: DailyReportSettingRow,
  slotUtc: string,
): Record<string, unknown> | null {
  if (!isValidTimezone(setting.timezone || "UTC")) return null;
  return {
    space_id: setting.space_id,
    user_id: setting.user_id,
    setting_id: setting.id,
    // The slot reports on the day before its own: the last complete local
    // day. A slot that fires late still names the day it was scheduled for.
    local_date: reportDateForSlot(slotUtc, setting.timezone),
    timezone: setting.timezone,
    trigger_origin: "automation",
  };
}
