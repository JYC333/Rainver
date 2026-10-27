import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
/** A retained Sources Reader document, not an operational hash mutation. */
export async function retainReaderBody(pool: Pool, input: {space: string; owner: string; item: string; text: string; attach?: boolean}): Promise<string> {
  const id=randomUUID();
  await pool.query(`INSERT INTO artifacts(id,space_id,owner_user_id,artifact_type,title,content,canonical_format,mime_type,export_formats_json,created_at,updated_at)
    VALUES($1,$2,$3,'source_reader_document','Retained body',$4,'reader_document_json','application/json','[]',now(),now())`,
    [id,input.space,input.owner,JSON.stringify({schema_version:1,kind:'reader_document',extraction_method:'structured_html_v1',plain_text:input.text,content_json:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:input.text}]}]},image_count:0,image_policy:'none'})]);
  if (input.attach !== false) await pool.query('UPDATE source_items SET extracted_artifact_id=$2 WHERE space_id=$3 AND id=$1',[input.item,id,input.space]);
  return id;
}
