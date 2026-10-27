import { RUN_OUTPUT_LINK_PREFIX, PREVIEW_MAX_BYTES, rasterImageMime, type RunFilePreview } from '@rainver/protocol';
import { isAbsolute, relative } from 'node:path';
import type { ServerConfig } from '../../config.js';
import { HttpError, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';
import { PgRunRepository } from './repository.js';
import { bodyWithheld } from '../access/contentAccessTypes.js';
import { PgArtifactRepository } from '../artifacts/repository.js';
import { PgProjectFolderRepository } from '../projectFolders/repository.js';
import { resolveActiveLocationWithHost, locationAbsoluteRoot } from '../projectFolders/workspaceLocations.js';

/** Never interpret a model-written path as authority to read a host file. */
export async function readRunFilePreview(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, runId: string, source: string): Promise<RunFilePreview> {
  const run = await new PgRunRepository(db).getVisibleRun(identity.spaceId, identity.userId, runId);
  if (!run || bodyWithheld(run.effective_access_level)) throw new HttpError(404, 'Preview unavailable');
  try {
    if (source.startsWith('file:')) {
      const url = new URL(source);
      if (url.hostname && url.hostname !== 'localhost') throw new Error('remote file');
      source = url.pathname;
    }
    source = decodeURIComponent(source);
  } catch { throw new HttpError(422, 'Invalid file reference'); }
  if (!source || source.length > 4096 || /[\x00-\x1f\\]/.test(source)) throw new HttpError(422, 'Invalid file reference');
  const lineMatch = source.match(/(?::(\d+)|#L(\d+))$/);
  const path = lineMatch ? source.slice(0, -lineMatch[0].length) : source;
  const line = lineMatch ? Number(lineMatch[1] ?? lineMatch[2]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new HttpError(422, 'Invalid line');
  if (path.startsWith(RUN_OUTPUT_LINK_PREFIX)) {
    const name = path.slice(RUN_OUTPUT_LINK_PREFIX.length);
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpError(422, 'Invalid output name');
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM artifacts WHERE space_id = $1 AND run_id = $2 AND artifact_type = 'remote_output'
         AND metadata_json->>'source_filename' = $3 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [identity.spaceId, runId, name],
    );
    const artifact = rows.rows[0] ? await new PgArtifactRepository(db, config).getVisible(identity.spaceId, identity.userId, rows.rows[0].id, true) : null;
    if (!artifact || artifact.content === null) throw new HttpError(404, 'Preview unavailable or expired');
    if (artifact.metadata_json?.encoding === 'base64') {
      const bytes = Buffer.from(artifact.content, 'base64');
      const mime = rasterImageMime(bytes);
      if (!mime || bytes.length > PREVIEW_MAX_BYTES || bytes.toString('base64') !== artifact.content) throw new HttpError(415, 'Unsupported image');
      return { kind: 'image', name, mime_type: mime, content_base64: artifact.content };
    }
    if (Buffer.byteLength(artifact.content) > PREVIEW_MAX_BYTES) throw new HttpError(413, 'Preview too large');
    return { kind: 'text', name, content: artifact.content };
  }
  // A legacy absolute path may only locate this Run's registered primary
  // Folder, on its original Location. /tmp and unrelated host paths never read.
  if (!run.project_folder_id || !run.project_id || !run.workspace_location_id) throw new HttpError(404, 'File is not in this Run’s workspace');
  const location = await resolveActiveLocationWithHost(db, identity.spaceId, run.project_folder_id);
  if (location.id !== run.workspace_location_id) throw new HttpError(409, 'The workspace moved; open Files & Code to select its current Location');
  const root = location.execution_host_kind === 'remote' ? location.display_path : locationAbsoluteRoot(location, config.workspaceRoot);
  if (!root) throw new HttpError(404, 'Workspace path unavailable');
  const rel = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, '');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new HttpError(404, 'File is outside this Run’s workspace');
  const folders = new PgProjectFolderRepository(db, config);
  // Same policy, ACL, Host and no-symlink read as Files & Code, not a new reader.
  const image = /\.(?:png|jpe?g|gif|webp)$/i.test(rel);
  const file = await folders.getFile(identity, run.project_id, run.project_folder_id, rel, { workspaceLocationId: run.workspace_location_id, ...(image ? { includeOriginalBytes: true } : {}) });
  if (image) {
    const bytes = file.content_base64 ? Buffer.from(file.content_base64, 'base64') : null;
    const mime = bytes && rasterImageMime(bytes);
    if (!bytes || !mime || bytes.length > PREVIEW_MAX_BYTES) throw new HttpError(415, 'Image preview unavailable');
    return { kind: 'image', name: rel, mime_type: mime, content_base64: bytes.toString('base64') };
  }
  return { kind: 'workspace', project_id: run.project_id, folder_id: run.project_folder_id, path: rel, ...(line ? { line } : {}) };
}
