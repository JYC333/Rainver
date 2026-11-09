import {z} from 'zod';
import {MonitoringDetailsSchema} from './projectInformationMonitoring.js';
const id=z.string().trim().min(1).max(36);
const output=z.object({id,project_id:id,space_id:id}).strict();
export const PROJECT_INGRESS_SCHEMAS={
 'project.monitoring.details.update':{input:MonitoringDetailsSchema.extend({project_id:id}).strict(),output},
 'project.monitoring.state.update':{input:z.object({project_id:id,expected_version_id:id,paused:z.boolean()}).strict(),output},
} as const;
export const PROJECT_INGRESS_TITLES:Record<keyof typeof PROJECT_INGRESS_SCHEMAS,string>={
 'project.monitoring.details.update':'Edit monitoring details within approved limits',
 'project.monitoring.state.update':'Pause or resume confirmed Project monitoring',
};
