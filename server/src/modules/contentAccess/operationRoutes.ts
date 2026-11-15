import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
const params={resourceType:'resource_type',resourceId:'resource_id'};
export function registerContentAccessOperationRoutes(app:FastifyInstance,context:ModuleContext){
 registerOperationAdapters(app,context.config,[
  {method:'PUT',url:'/api/v1/content-access/:resourceType/:resourceId',operation:'content.access.update',params},
  {method:'POST',url:'/api/v1/content-access/:resourceType/:resourceId/demotion-disclosures',operation:'content.demotion.disclose',params},
  {method:'POST',url:'/api/v1/content-access/:resourceType/:resourceId/publication-proposals',operation:'content.publication.request',params},
 ]);
}
