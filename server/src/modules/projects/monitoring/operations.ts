import {PROJECT_INGRESS_SCHEMAS,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import type {OperationRegistration} from '../../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../../systemActions/operations/errors.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from '../access.js';
import {ProjectMonitoringService} from './service.js';
import {MonitoringControlError} from './operationErrors.js';
type Input={project_id:string;expected_version_id:string;paused:boolean};
export function projectIngressRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (['project.monitoring.details.update','project.monitoring.state.update'] as const satisfies readonly (keyof typeof PROJECT_INGRESS_SCHEMAS)[]).map(id=>({
  definition:definitions.get(id)!,
  async resolve(_db,raw){const i=raw as Input;return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,version_id:i.expected_version_id},resourceType:'project',resourceId:i.project_id};},
  async authorize(db,raw,a){const i=raw as Input;
   await assertProjectWriter(db,a.space_id,i.project_id,a.on_behalf_of_user_id!,{allowArchived:true});
   await lockActiveProjectForMutation(db,a.space_id,i.project_id);
   await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
   const version=(await db.query<{source_channel_id:string}>('SELECT source_channel_id FROM project_information_monitoring_versions WHERE id=$1 AND space_id=$2 AND project_id=$3 FOR SHARE',[i.expected_version_id,a.space_id,i.project_id])).rows[0];
   if(!version)throw hidden();
   // Details append a version with this exact executable query fingerprint.
   await db.query('SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 FOR SHARE',[version.source_channel_id,a.space_id]);
   await db.query('SELECT id FROM source_search_specs WHERE source_channel_id=$1 AND space_id=$2 ORDER BY id FOR SHARE',[version.source_channel_id,a.space_id]);
  },
  async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string;project_id:string};if(out.space_id!==a.space_id)throw hidden();await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);if(!(await db.query('SELECT id FROM project_information_monitoring_versions WHERE id=$1 AND space_id=$2 AND project_id=$3',[out.id,a.space_id,out.project_id])).rows.length)throw hidden();},
  async execute(db,raw,a){const i=raw as Input,service=new ProjectMonitoringService(db,config),person={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
   const body={...raw as Record<string,unknown>};delete body.project_id;
   const row=id==='project.monitoring.details.update'?await service.details(person,i.project_id,body):await service.setPaused(person,i.project_id,i.expected_version_id,i.paused);
   return {id:'id' in row?row.id:i.expected_version_id,space_id:a.space_id,project_id:i.project_id};
  },
  classifyError(e){if(e instanceof MonitoringControlError||e instanceof ProjectArchivedMutationError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'projects');return undefined;},
 }));
}
