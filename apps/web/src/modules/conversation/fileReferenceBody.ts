import { CONVERSATION_MAX_FILE_SNAPSHOT_BYTES } from '@rainver/protocol'
import type { FileContent } from '../../types/api'

/** Hash the same decoded body the server will freeze, apart from disk metadata such as a BOM. */
export async function fileReferenceBody(file: FileContent, errors: { encoding: string; size: string }) {
  if (file.encoding && file.encoding !== 'utf8') throw new Error(errors.encoding)
  const bytes = new TextEncoder().encode(file.content)
  if (bytes.byteLength > CONVERSATION_MAX_FILE_SNAPSHOT_BYTES) throw new Error(errors.size)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return { byte_size: bytes.byteLength, sha256 }
}
