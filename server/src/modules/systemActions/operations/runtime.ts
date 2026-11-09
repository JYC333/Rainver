import {researchExecutionRegistrations} from '../../projectResearch/executionOperations.js';
import {researchAdhocRegistration} from '../../projectResearch/adhocOperation.js';
import {projectSourceProposalRegistrations} from '../../projects/sourceProposalOperations.js';
import {projectCorpusRegistrations} from '../../projects/corpusOperations.js';
import {inquiryAgentOperationRegistrations} from '../../inquiry/agentOperations.js';
import {projectFolderRegistrations} from '../../projectFolders/operations.js';
import {projectFolderIoRegistrations} from '../../projectFolders/ioOperations.js';
import {inquiryOperationRegistrations} from '../../inquiry/operations.js';
import {projectIngressRegistrations} from '../../projects/monitoring/operations.js';
import {projectManagementRegistrations} from '../../projects/managementOperations.js';
import {experimentRegistrations} from '../../experiments/operations.js';
import {researchWorkspaceRegistrations} from '../../projectResearch/workspaceOperations.js';
import {knowledgeExtractionRegistration} from '../../knowledgePromotion/extractionOperation.js';
import {workspaceOperationRegistrations} from "../../projectFolders/workspaceOperations.js";
import {knowledgeReviewRegistrations} from '../../knowledgePromotion/reviewOperations.js';
import {knowledgeObjectRegistrations} from '../../knowledge/knowledgeObjectOperations.js';
import {noteObjectRegistrations} from '../../knowledge/noteObjectOperations.js';
import {sourceProcessingRegistrations} from '../../sources/sourceProcessingOperations.js';
import {sourceChannelCreateRegistration} from '../../sources/sourceChannelCreateOperation.js';
import {noteControlRegistrations} from '../../knowledge/noteControlOperations.js';
import {sourceMonitorRegistrations} from '../../sources/sourceMonitorOperations.js';
import {sourceRecipeCreateRegistration} from '../../sources/sourceRecipeCreateOperation.js';
import {sourceSubscriptionRegistrations} from '../../sources/sourceSubscriptionOperations.js';
import {projectSourceRegistrations} from '../../projects/projectSourceOperations.js';
import {threadCreationRegistrations} from '../../inquiry/threadCreationOperations.js';
import {taskLifecycleRegistrations} from '../../projectWork/taskLifecycleOperations.js';
import {taskSpacePlacementRegistration} from '../../projectWork/taskSpacePlacementOperation.js';
import {sourceBackfillRegistrations} from '../../sources/sourceBackfillOperations.js';
import { boardOperationRegistrations } from '../../projectWork/boardOperations.js';
import { projectOperationRegistrations } from '../../projects/projectOperationOperations.js';
import { collaborationParticipantsRegistration } from '../../agentGroups/collaborationParticipantsOperation.js';
import { actionGrantRegistrations } from '../../policy/actionGrantOperations.js';
import { pluginOperations } from "../../plugins/operationRegistry.js";
import { researchCancelRegistration } from '../../projectResearch/researchCancelOperation.js';
import type { ServerConfig } from '../../../config.js';
import { dbPool } from '../../routeUtils/common.js';
import { loadSystemActionRegistry } from '../registry.js';
import { OperationExecutor } from './executor.js';
import { catalogRegistration } from './catalog.js';
const runtimes = new WeakMap<ServerConfig, Promise<OperationExecutor>>();
/** Composition-scoped, never Run-scoped. Registrations close over no caller. */
export function operationRuntime(config: ServerConfig): Promise<OperationExecutor> {
  let runtime = runtimes.get(config);
  if (!runtime) {
    runtime = loadSystemActionRegistry(config).then(definitions => new OperationExecutor(dbPool(config), config, [...workspaceOperationRegistrations(definitions,config),collaborationParticipantsRegistration(definitions),catalogRegistration(config,definitions),...threadCreationRegistrations(definitions),...noteControlRegistrations(definitions),...noteObjectRegistrations(definitions),...knowledgeObjectRegistrations(definitions),...knowledgeReviewRegistrations(definitions),knowledgeExtractionRegistration(definitions),...researchWorkspaceRegistrations(definitions,config),...researchExecutionRegistrations(definitions,config),researchAdhocRegistration(definitions,config),...projectSourceProposalRegistrations(definitions,config),...projectCorpusRegistrations(definitions),...projectFolderRegistrations(definitions,config),...projectFolderIoRegistrations(definitions,config),...inquiryOperationRegistrations(definitions),...inquiryAgentOperationRegistrations(definitions),...projectIngressRegistrations(definitions,config),...projectManagementRegistrations(definitions,config),...experimentRegistrations(definitions), researchCancelRegistration(definitions),...actionGrantRegistrations(config,definitions),...projectOperationRegistrations(definitions),...projectSourceRegistrations(definitions),...boardOperationRegistrations(config,definitions),...taskLifecycleRegistrations(config,definitions),taskSpacePlacementRegistration(config,definitions),...sourceBackfillRegistrations(definitions),...sourceSubscriptionRegistrations(config,definitions),...sourceMonitorRegistrations(config,definitions),sourceRecipeCreateRegistration(config,definitions),sourceChannelCreateRegistration(config,definitions),...sourceProcessingRegistrations(config,definitions),...pluginOperations(config)]));
    runtimes.set(config, runtime);
  }
  return runtime;
}
