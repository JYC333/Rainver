import type { ActivityInboxRecord, CaptureRequest, RelocationPreview, RelocationRequest } from '../types/api'
import { commandReceipt, operationAt } from './operations'
import type { RequestOptions } from './transport'
import { get } from './transport'
import type { OperationInput, OperationOutput } from '@rainver/protocol'

// ── Capture ───────────────────────────────────────────────────────────────
/**
 * The single capture entry. Destination is chosen by the client and sent
 * explicitly; the server never re-infers one, because the signal the default
 * reads (a paste event) exists only in the browser.
 */
export const captureApi = {
  create: (body: CaptureRequest, key: string = crypto.randomUUID(), spaceId?: string) =>
    commandReceipt('capture.create', body, key, { spaceId }),
  /** What a relocation would carry — the anchored block plus the orphans after it. */
  relocationPreview: (activityId: string) =>
    get<RelocationPreview>(`/captures/${activityId}/relocation`),
  relocate: (activityId: string, body: RelocationRequest,key:string=crypto.randomUUID()) =>
    commandReceipt('capture.relocate',{...body,activity_id:activityId},key),
}

// ── Activity ──────────────────────────────────────────────────────────────
export const activityApi = {
  list: (params: {
    status?: string
    source_type?: string
    project_folder_id?: string
    project_id?: string
    limit?: number
    offset?: number
  } = {}, options: RequestOptions = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.source_type !== undefined) q.source_type = params.source_type
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<ActivityInboxRecord[]>('/activity?' + new URLSearchParams(q), options)
  },
  create: (
    data: OperationInput<'activity.create'>,
    options: { spaceId?: string; key?:string } = {},
  ) =>
    operationAt<OperationOutput<'activity.create'>>('POST','/activity',data,options.key??crypto.randomUUID(),{spaceId:options.spaceId}),
  // File / voice capture (store-only). Sends multipart; lands in the Activity Inbox.
  upload: (
    file: File,
    options: { kind?: 'file' | 'voice'; title?: string; note?: string; project_folder_id?: string; project_id?: string; spaceId?: string; key?:string } = {},
  ) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', options.kind ?? 'file')
    if (options.title) fd.append('title', options.title)
    if (options.note) fd.append('note', options.note)
    if (options.project_folder_id) fd.append('project_folder_id', options.project_folder_id)
    if (options.project_id) fd.append('project_id', options.project_id)
    return operationAt<OperationOutput<'activity.upload'>>('POST','/activity/upload',fd,options.key??crypto.randomUUID(),{spaceId:options.spaceId})
  },
  get:    (id: string, options: RequestOptions = {}) => get<ActivityInboxRecord>(`/activity/${id}`, options),
  review: (id: string,key:string=crypto.randomUUID()) => commandReceipt('activity.review',{activity_id:id},key),
  archive:(id: string,key:string=crypto.randomUUID()) => commandReceipt('activity.archive',{activity_id:id},key),
  consolidate: (id: string,key:string=crypto.randomUUID()) =>
    commandReceipt('activity.consolidate',{activity_id:id},key),
  summarize: (body: OperationInput<'activity.summary.request'>,key:string=crypto.randomUUID()) =>
    commandReceipt('activity.summary.request',body,key),
}

/** Personal receipt storage grants no destination authority. Keep the key for an explicit retry. */
export const captureFilingApi = {
  file: (body: import('@rainver/protocol').OperationInput<'capture.file'>, key: string) => operationAt<OperationOutput<'capture.file'>>('POST','/me/filings',body,key),
};
