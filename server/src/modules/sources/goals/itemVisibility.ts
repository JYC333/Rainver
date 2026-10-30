import {contentAccessLevelSql,projectReadAccessSql} from '../../access/contentAccessSql.js';
import {contentResourceDefinition} from '../../access/contentAccessRegistry.js';
import {sourceConnectionReaderConsentClause,sourceItemDocumentReadableClause} from '../sourceItemAccess.js';
/** Material authority follows the actual SourceItem, not its collecting binding.
 * Cited change evidence/reasons require full access; summary readers get no body-derived signal. */
export function goalItemReadableSql(item:string,user:string,full=false){
 const readable=`${item}.deleted_at IS NULL AND ${sourceItemDocumentReadableClause(item,user,{includeOversight:false})}`;
 return full?`${readable} AND ${contentAccessLevelSql({definition:contentResourceDefinition('source_item')!,alias:item,userExpr:user,includeOversight:false})}='full'`:readable;
}
export function goalVisibleSql(goal:string,user:string){return `${goal}.status<>'deleted' AND ((${goal}.project_id IS NULL AND ${goal}.owner_user_id=${user}) OR (${goal}.project_id IS NOT NULL AND ${projectReadAccessSql(`${goal}.space_id`,`${goal}.project_id`,user)}))`;}

/** Keep collecting provenance behind its own Source gate as well. This does
 * not replace the independent actual-material gate above. */
export function goalCollectionReadableSql(change:string,user:string){return `EXISTS(SELECT 1 FROM source_goal_bindings change_binding JOIN source_connections collecting_source ON collecting_source.id=change_binding.source_connection_id AND collecting_source.space_id=change_binding.space_id WHERE change_binding.id=${change}.binding_id AND change_binding.space_id=${change}.space_id AND ${sourceConnectionReaderConsentClause('collecting_source',user,`${change}.detected_at`,{includeOversight:false})} AND ${contentAccessLevelSql({definition:contentResourceDefinition('source_connection')!,alias:'collecting_source',userExpr:user,includeOversight:false})}='full')`;}
