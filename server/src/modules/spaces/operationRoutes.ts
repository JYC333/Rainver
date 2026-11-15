import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
/** Retained Space URLs; a `:spaceId` URL acts in exactly that Space. */
export function registerSpaceOperationRoutes(app:FastifyInstance,context:ModuleContext){
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/spaces',operation:'space.create'},
  {method:'POST',url:'/api/v1/spaces/:spaceId/invitations',operation:'space.invitation.create',spaceParam:'spaceId'},
  {method:'POST',url:'/api/v1/invitations/accept',operation:'space.invitation.accept'},
  {method:'PATCH',url:'/api/v1/spaces/:spaceId/snapshot-defaults',operation:'space.snapshot_defaults.update',spaceParam:'spaceId'},
  {method:'PATCH',url:'/api/v1/spaces/:spaceId/content-egress',operation:'space.content_egress.update',spaceParam:'spaceId'},
  {method:'PATCH',url:'/api/v1/spaces/:spaceId/retrieval-settings',operation:'space.retrieval_settings.update',spaceParam:'spaceId'},
 ]);
}
