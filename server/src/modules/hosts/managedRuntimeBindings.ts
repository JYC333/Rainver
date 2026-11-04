import type {Queryable} from '../routeUtils/common.js';
import {normalizeHostCapabilities} from './capabilities.js';

/**
 * Managed upgrades and rollback retain one HOME per Host/runtime (ADR 0016 §9).
 * Synchronize live execution targets with that Host's verified current copy.
 * Runs, closed threads, backend snapshots, accounts and workspaces are untouched.
 * The caller holds the Host row lock and commits its capabilities atomically.
 */
export async function syncManagedRuntimeBindings(db:Queryable,hostId:string,capabilities:unknown):Promise<void>{
  const copies=Object.entries(normalizeHostCapabilities(capabilities).installations).flatMap(([runtime_key,installations])=>{
    const managed=installations.filter(copy=>copy.id.startsWith('managed:'));
    if(managed.length!==1)return [];
    const copy=managed[0]!;
    return copy.health_check_protocol==='acp' && copy.version && copy.id!=='managed:pending' && copy.id===`managed:${copy.version}`
      ? [{runtime_key,installation:copy.id}] : [];
  });
  if(!copies.length)return;
  await db.query(`WITH current_copies AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(runtime_key text,installation text)
  ), profiles AS (
    UPDATE agent_runtime_profiles p
       SET runtime_installation=c.installation,updated_at=now()
      FROM current_copies c
     WHERE p.execution_host_id=$1 AND p.runtime_key=c.runtime_key
       AND p.runtime_installation LIKE 'managed:%'
       AND p.runtime_installation<>'managed:pending'
       AND p.runtime_installation<>c.installation
    RETURNING p.id
  )
  UPDATE host_threads t
     SET runtime_installation=c.installation,updated_at=now()
    FROM current_copies c
   WHERE t.execution_host_id=$1 AND t.runtime_key=c.runtime_key
     AND t.runtime_installation LIKE 'managed:%'
     AND t.runtime_installation<>'managed:pending'
     AND t.runtime_installation<>c.installation
     AND t.status IN ('active','session_reset')`,[hostId,JSON.stringify(copies)]);
}
