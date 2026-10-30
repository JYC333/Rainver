import type {Queryable} from '../../routeUtils/common.js';
/** Built-in metadata, not a provider API or credential route. Preserve admin state. */
export async function seedNativeSearchCatalog(db:Queryable){
 await db.query(`INSERT INTO source_providers(id,provider_key,display_name,provider_kind,category,status,capabilities_json,config_schema_json,created_at,updated_at) VALUES('00000000-0000-4000-8000-00000000e009','agent_native_search','Selected Agent search','generic','web','active','{"native_agent":true}','{}',now(),now()) ON CONFLICT DO NOTHING`);
 await db.query(`INSERT INTO source_connectors(id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,config_schema_json,created_at,updated_at) VALUES('00000000-0000-4000-8000-00000000f009','agent_native_search','Native Agent execution','external_feed','pull','active','{"native_agent":true}','{}',now(),now()) ON CONFLICT DO NOTHING`);
 await db.query(`INSERT INTO source_provider_connectors(id,provider_id,connector_id,status,priority,capabilities_json,config_schema_json,created_at,updated_at) VALUES('00000000-0000-4000-8000-00000000d009','00000000-0000-4000-8000-00000000e009','00000000-0000-4000-8000-00000000f009','active',10,'{"native_agent":true}','{}',now(),now()) ON CONFLICT DO NOTHING`);
}
