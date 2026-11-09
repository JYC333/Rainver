import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerProjectManagementOperationRoutes} from '../projects/managementOperationRoutes.js';
export function registerRoutes(app:FastifyInstance,context:ModuleContext):void {
 registerProjectManagementOperationRoutes(app,context,'projectReview');
}
