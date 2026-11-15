import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
import {registerAskResultRoute} from './requestResult.js';

export function registerRoutes(app:FastifyInstance,context:ModuleContext):void{
 registerOperationAdapters(app,context.config,[{method:'POST',url:'/api/v1/ask-space/think',operation:'ask_space.think'}]);
 registerAskResultRoute(app,context);
}
