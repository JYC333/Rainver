import {requireNativeCollector} from './nativeSafety.js';
import {PgCustomSourceHandlerRepository} from '../customSources/customSourceHandlerRepository.js';
import {nativeProfileFingerprint} from './nativeRoute.js';
import {PgConversationBackendRepository} from '../../sessions/conversationBackendRepository.js';
import {resolveSessionConfig} from '../../sessions/sessionConfig.js';
import {sourceConnectorRegistry} from '../catalog/sourceConnectorRegistry.js';
import type {ServerConfig} from '../../../config.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {sourceGoalError} from './dispatchError.js';
import {requireGoalSource,type GoalRow} from './access.js';
import {type SourceGoalBindingSpec} from '@rainver/protocol';
import {CustomSourceCredentialService} from '../customSources/customSourceCredentialService.js';
/** Metadata-only admission; no secret is resolved and no network call is made. */
export async function preflightGoalSource(db:Queryable,config:ServerConfig,identity:SpaceUserIdentity,g:GoalRow,spec:SourceGoalBindingSpec,allowPaused=false){
 const draft=spec.implementation.kind==='agent_search'&&(await db.query("SELECT 1 FROM source_connections WHERE id=$1 AND space_id=$2 AND config_json->>'native_draft'='true'",[spec.source_connection_id,identity.spaceId])).rows.length>0;
 const c=await requireGoalSource(db,config,identity,g,spec,true,allowPaused||draft);
 if(spec.implementation.kind==='agent_search'){await requireNativeCollector(db,g.runtime_profile_id);const route=spec.implementation.route;if(!route||route.agent_id!==g.agent_id||route.runtime_profile_id!==g.runtime_profile_id)throw sourceGoalError(409,'source_native_route_changed');await db.query('SELECT id FROM agent_runtime_profiles WHERE id=$1 FOR SHARE',[route.runtime_profile_id]);if(route.profile_sha256!==await nativeProfileFingerprint(db,route.runtime_profile_id))throw sourceGoalError(409,'source_native_route_changed');const option=(await new PgConversationBackendRepository(db).listOptions(g.space_id,g.owner_user_id,g.agent_id)).find(o=>o.runtime_profile_id===g.runtime_profile_id);if(!option||option.usable===false)throw sourceGoalError(409,'source_native_route_changed');const current=await resolveSessionConfig(route.session_config,async()=>[],option.session_config_options??[]);if(JSON.stringify(current.selections)!==JSON.stringify(route.session_config))throw sourceGoalError(409,'source_native_route_changed');}
 const catalog=(await db.query<{enabled:boolean;required:boolean}>(`SELECT (p.status='active' AND pc.status='active' AND co.status='active') AS enabled,(co.connector_key='brave_web_search_api' OR COALESCE((pc.capabilities_json->>'requires_credential')::boolean,false) OR COALESCE((p.capabilities_json->>'requires_credential')::boolean,false)) AS required FROM source_provider_connectors pc JOIN source_providers p ON p.id=pc.provider_id JOIN source_connectors co ON co.id=pc.connector_id WHERE pc.id=$1`,[c.provider_connector_id])).rows[0];
 if((g.execution_search_path??g.compatibility_json?.search_path)==='agent'&&spec.implementation.kind!=='agent_search'&&['arxiv_api','openalex_api','semantic_scholar_api','brave_web_search_api'].includes(c.connector_key))throw sourceGoalError(409,'source_search_path_confirmation_required');
 if((g.execution_search_path??g.compatibility_json?.search_path)==='api'&&spec.implementation.kind==='agent_search')throw sourceGoalError(409,'source_search_path_confirmation_required');
 if(c.connector_key==='agent_native_search'&&spec.implementation.kind!=='agent_search')throw sourceGoalError(409,'source_native_implementation_required');
 if(!catalog?.enabled)throw sourceGoalError(409,'source_source_disabled');
 if(catalog.required&&!c.credential_id)throw sourceGoalError(409,'source_credential_decision_required');
 if(c.credential_id){const settings=await new PgCustomSourceHandlerRepository(db,config).getEffectiveSettings(identity);if(!settings.space.credentialed_sources_allowed)throw sourceGoalError(403,'source_credential_policy_disabled');const owned=await db.query(`SELECT 1 FROM credentials WHERE id=$1 AND space_id=$2 AND COALESCE(metadata_json->>'disabled','false')<>'true'`,[c.credential_id,identity.spaceId]);if(!owned.rows.length)throw sourceGoalError(409,'source_credential_decision_required');try{await new CustomSourceCredentialService(db,config).requireOwnCredential(identity,c.credential_id);}catch(error){if(error instanceof HttpError&&[403,404].includes(error.statusCode))throw sourceGoalError(409,'source_credential_decision_required');throw error;}}
 if(c.connector_key!=='agent_native_search'&&sourceConnectorRegistry.get(c.connector_key).getCapabilities().supports_search){if(!c.provider_query_json||!Object.keys(c.provider_query_json as object).length)throw sourceGoalError(409,'source_search_query_unavailable');sourceConnectorRegistry.get(c.connector_key).buildScanRequest({endpoint_url:c.endpoint_url,compiled_query:c.provider_query_json},{});}
 return c;
}
