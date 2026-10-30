import {SourceMaterialReadingContentSchema} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {HttpError,withDbTransaction,type Pool,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {PgReaderRepository} from '../../reader/repository.js';
import {agentReadingDocument,agentReadingMetadata,saveSourceReadingDocument} from './documents.js';
import {requireProcessingItem} from './items.js';
import {agentReadingPolicy} from './policy.js';

/** The version the person saw and asked about: the Reader payload's `artifact_id` and `source_snapshot_id`. */
export interface ShownVersion { artifact_id:string; source_snapshot_id:string|null }

/**
 * Shows one version of Agent-provided text as Markdown, on a writer's explicit
 * request.
 *
 * The request names the version the Reader showed. Under the item's row lock
 * the shown version is resolved again by the Reader's own rule (current
 * extracted artifact, else latest readable extracted snapshot, same gates); if
 * it is not the one named, nothing changes (409: the text was updated, look at
 * it again). Only Agent text kept literally qualifies — syntax undeclared, or
 * declared `plain` and now explicitly asked for as Markdown — known from that
 * version's own artifact, never from the text; a `markdown` version is not
 * converted again. Its stored text is exactly what the Agent submitted, and its
 * kind, format and sources come from the same version's metadata. The result is
 * saved through the canonical writer as a new version: the shown version and
 * its snapshot are kept, annotations are relocated or listed as not located,
 * read state follows the writer's revision guards. One material per request;
 * nothing is backfilled.
 */
export async function showAgentTextAsMarkdown(db:Pool,config:ServerConfig,identity:SpaceUserIdentity,itemId:string,shown:ShownVersion){
 return withDbTransaction(db,async tx=>{
  // The same authority as reading it again: a writer of the material, under the Source's storage policy.
  const {source}=await requireProcessingItem(tx,identity,itemId);
  if(source&&!agentReadingPolicy(source).content)throw new HttpError(403,'source_material_storage_consent_required');
  const item=(await tx.query<{content_hash:string|null;source_uri:string|null}>(`SELECT content_hash,source_uri FROM source_items WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR UPDATE`,[itemId,identity.spaceId])).rows[0];
  if(!item)throw new HttpError(404,'Material not found');
  const version=await new PgReaderRepository(tx,config).shownSourceItemVersion(identity,itemId);
  if(!version||version.artifactId!==shown.artifact_id||version.snapshotId!==shown.source_snapshot_id){const message='The text was updated; look at it again before choosing';throw Object.assign(new HttpError(409,message,{detail:message,code:'reading_version_changed'}),{code:'reading_version_changed'});}
  const syntax=version.content.agentTextSyntax;
  if(syntax!=='undeclared'&&syntax!=='plain')throw new HttpError(409,'Only Agent text shown literally can be shown as Markdown');
  const meta=version.content.metadata;
  const content=SourceMaterialReadingContentSchema.safeParse({kind:meta.reading_content_kind,format:meta.reading_content_format,syntax:'markdown',text:version.content.text,sources:meta.reading_sources});
  if(!content.success)throw new HttpError(409,'The saved Agent text cannot be converted');
  const saved=await saveSourceReadingDocument(tx,{spaceId:identity.spaceId,itemId,document:agentReadingDocument(content.data,item.source_uri??''),metadata:agentReadingMetadata(content.data),agentProvided:true,expectedHash:item.content_hash});
  return {artifact_id:saved.artifactId};
 });
}
