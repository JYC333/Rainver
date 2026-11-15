import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
export function registerRoutes(app:FastifyInstance,context:ModuleContext):void{
 registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/me/filings',operation:'capture.file',admission:'person'}]);
}
