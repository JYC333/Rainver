import type {SkillLocalOverlayScope} from '@rainver/protocol';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {lockSourceRetrievalRelease} from '../sources/retrievalReleaseLocks.js';
import {PgSkillsRepository} from './repository.js';

/** The canonical content closure discovers Projects/shares/Folder placement,
 * locks in its global order, and rediscovers before the scope owner's check.
 * The same gate is used at proposal submission and at actual application. */
export async function lockSkillScopeAuthority(db:Queryable,person:SpaceUserIdentity,scope:SkillLocalOverlayScope,scopeId:string|null){
 await lockSourceRetrievalRelease(db,person.spaceId,person.userId,
  scope==='agent'&&scopeId?[{object_type:'agent',object_id:scopeId}]:[],
  scope==='project'&&scopeId?[scopeId]:[],undefined,
  scope==='project_folder'&&scopeId?[scopeId]:[]);
 await new PgSkillsRepository(db).assertOverlayScopeAuthority(person,scope,scope==='user'?(scopeId??person.userId):scopeId,'write');
}
