import {z} from 'zod';
import {MonitoringDetailsSchema,MonitoringFeedbackSchema,MonitoringRunRequestSchema,MonitoringSourceSetupSchema,ProposeProjectMonitoringSchema} from './projectInformationMonitoring.js';
import {ProjectSourceBindInputSchema} from './projectSourceOperations.js';
import {SourceChannelCreateInputSchema} from './sourceChannelCreateOperation.js';
import {RetrievalFeedbackRequestSchema} from './knowledgeRetrieval.js';
const id=z.string().trim().min(1).max(36);
const project={project_id:id};
const output=z.object({id,project_id:id,space_id:id}).strict();
/** Proposal submissions return identifiers only; review content is read through the Proposal surfaces. */
const setupOutput=output.extend({source_channel_id:id,source_proposal_id:id,binding_proposal_id:id}).strict();
const bindingOptions=ProjectSourceBindInputSchema.omit({project_id:true,source_channel_id:true,backfill_history:true});
export const PROJECT_INGRESS_POLICY={
 'project.monitoring.details.update':'project.monitoring.configure',
 'project.monitoring.state.update':'project.monitoring.configure',
 'project.monitoring.source.setup':'source.connection.manage',
 'project.monitoring.proposal.create':'project.monitoring.configure',
 'project.monitoring.reconcile':'project.monitoring.configure',
 'project.monitoring.run.start':'project.monitoring.configure',
 'project.monitoring.feedback':'project.monitoring.configure',
 'project.source.bind.propose':'project.source.bind',
 'project.source.setup.propose':'source.connection.manage',
 'project.summary.feedback':'project.summary.feedback',
} as const;
/** Human submissions that create a pending owner Proposal; each keeps its Agent equivalent's money gate. */
export const PROJECT_INGRESS_PROPOSALS={
 'project.monitoring.source.setup':'source_channel_activation',
 'project.monitoring.proposal.create':'project_information_monitoring_activation',
 'project.source.bind.propose':'project_source_bind',
 'project.source.setup.propose':'source_channel_activation',
} as const;
export const PROJECT_INGRESS_SCHEMAS={
 'project.monitoring.details.update':{input:MonitoringDetailsSchema.extend(project).strict(),output},
 'project.monitoring.state.update':{input:z.object({...project,expected_version_id:id,paused:z.boolean()}).strict(),output},
 'project.monitoring.source.setup':{input:MonitoringSourceSetupSchema.extend(project).strict(),output:setupOutput},
 'project.monitoring.proposal.create':{input:ProposeProjectMonitoringSchema.extend(project).strict(),output:output.extend({version_id:id.nullable()}).strict()},
 'project.monitoring.reconcile':{input:z.object(project).strict(),output:output.extend({coordinator_active:z.boolean()}).strict()},
 'project.monitoring.run.start':{input:MonitoringRunRequestSchema.extend(project).strict(),output},
 'project.monitoring.feedback':{input:MonitoringFeedbackSchema.extend({...project,item_id:id}).strict(),output:output.extend({feedback:MonitoringFeedbackSchema.shape.feedback}).strict()},
 'project.source.bind.propose':{input:bindingOptions.extend({...project,source_channel_id:id,depends_on_proposal_id:id.nullable().optional()}).strict(),output},
 'project.source.setup.propose':{input:z.object({...project,idempotency_key:z.string().trim().min(1).max(128),operation_title:z.string().trim().min(1).max(200).optional(),intent_text:z.string().trim().max(4000).optional(),source:SourceChannelCreateInputSchema.omit({status:true}),binding:bindingOptions.default({})}).strict(),output:setupOutput},
 'project.summary.feedback':{input:RetrievalFeedbackRequestSchema.extend({object_type:z.literal('project_public_summary')}).strict(),output:z.object({id,space_id:id}).strict()},
} as const;
export const PROJECT_INGRESS_TITLES:Record<keyof typeof PROJECT_INGRESS_SCHEMAS,string>={
 'project.monitoring.details.update':'Edit monitoring details within approved limits',
 'project.monitoring.state.update':'Pause or resume confirmed Project monitoring',
 'project.monitoring.source.setup':'Propose a monitoring Source for review',
 'project.monitoring.proposal.create':'Propose Project monitoring scope or details',
 'project.monitoring.reconcile':'Reconcile stopped Project monitoring work',
 'project.monitoring.run.start':'Queue a confirmed Project monitoring run',
 'project.monitoring.feedback':'Record private monitoring recommendation feedback',
 'project.source.bind.propose':'Propose binding a Source to a Project',
 'project.source.setup.propose':'Propose a new Source and its Project binding',
 'project.summary.feedback':'Record private feedback on a public summary search result',
};
