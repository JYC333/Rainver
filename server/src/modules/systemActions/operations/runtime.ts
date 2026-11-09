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
    runtime = loadSystemActionRegistry(config).then(definitions => new OperationExecutor(dbPool(config), config, [collaborationParticipantsRegistration(definitions),catalogRegistration(config,definitions),...threadCreationRegistrations(definitions),...noteControlRegistrations(definitions),...noteObjectRegistrations(definitions),...knowledgeObjectRegistrations(definitions),...knowledgeReviewRegistrations(definitions), researchCancelRegistration(definitions),...actionGrantRegistrations(config,definitions),...projectOperationRegistrations(definitions),...projectSourceRegistrations(definitions),...boardOperationRegistrations(config,definitions),...taskLifecycleRegistrations(config,definitions),taskSpacePlacementRegistration(config,definitions),...sourceBackfillRegistrations(definitions),...sourceSubscriptionRegistrations(config,definitions),...sourceMonitorRegistrations(config,definitions),sourceRecipeCreateRegistration(config,definitions),sourceChannelCreateRegistration(config,definitions),...sourceProcessingRegistrations(config,definitions),...pluginOperations(config)]));
    runtimes.set(config, runtime);
  }
  return runtime;
}
