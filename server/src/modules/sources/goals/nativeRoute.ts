import {createHash} from 'node:crypto';
import type {Queryable} from '../../routeUtils/common.js';
export async function nativeProfileFingerprint(db:Queryable,id:string){const p=(await db.query(`SELECT runtime_key,backend_mode,model_provider_id,model_name,runtime_config_json,runtime_policy_json,execution_host_id,workspace_location_id,runtime_installation,enabled FROM agent_runtime_profiles WHERE id=$1`,[id])).rows[0];return createHash('sha256').update(JSON.stringify(p??null)).digest('hex');}
