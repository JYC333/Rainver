import type {FastifyInstance} from 'fastify';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {registerOperationAdapters} from '../systemActions/operations/routeAdapter.js';
export function registerRelationOperationRoutes(app:FastifyInstance,context:ModuleContext){
 registerOperationAdapters(app,context.config,[
  {method:'POST',url:'/api/v1/relations/people',operation:'relation.person.create'},
  {method:'PATCH',url:'/api/v1/relations/people/:objectId',operation:'relation.person.update',params:{objectId:'object_id'}},
  {method:'DELETE',url:'/api/v1/relations/people/:objectId',operation:'relation.person.archive',params:{objectId:'object_id'}},
  {method:'POST',url:'/api/v1/relations/organizations',operation:'relation.organization.create'},
  {method:'POST',url:'/api/v1/relations/:objectId/identities',operation:'relation.identity.create',params:{objectId:'object_id'}},
  {method:'DELETE',url:'/api/v1/relations/identities/:identityId',operation:'relation.identity.delete',params:{identityId:'identity_id'}},
  {method:'POST',url:'/api/v1/relations/affiliations',operation:'relation.affiliation.propose'},
  {method:'POST',url:'/api/v1/relations/affiliations/:affiliationId/end',operation:'relation.affiliation.end.propose',params:{affiliationId:'affiliation_id'}},
  {method:'POST',url:'/api/v1/relations/:objectId/notes',operation:'relation.note.create',params:{objectId:'object_id'}},
  {method:'POST',url:'/api/v1/relations/:objectId/source-links',operation:'relation.source_link.create',params:{objectId:'object_id'}},
 ]);
}
