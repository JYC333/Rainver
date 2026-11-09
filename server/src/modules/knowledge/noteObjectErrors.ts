import {ProjectArchivedMutationError} from '../projects/access.js';
import { HttpError } from '../routeUtils/common.js';
import { OperationBusinessError } from '../systemActions/operations/errors.js';
/** Opted-in domain validation sites only, not arbitrary helper HTTP failures. */
export class NoteObjectError extends HttpError {}
export function noteObjectFailure(error: unknown) {
  if (!(error instanceof NoteObjectError)&&!(error instanceof ProjectArchivedMutationError)) return undefined;
  const failure = new OperationBusinessError(error.statusCode === 409 ? 'operation_conflict' : 'operation_invalid_input', error.statusCode === 409 ? 409 : 422, 'knowledge');
  const data = error.responseBody as Record<string, unknown> | undefined;
  if (data && ['note_owning_entry_required', 'note_cross_project_share_required'].includes(String(data.code))) {
    const safe = Object.fromEntries(['code', 'note_id', 'note_title', 'owning_project_id', 'owner_project_id', 'actions', 'affected_note_count'].filter(k => Object.hasOwn(data, k)).map(k => [k, data[k]]));
    const body = failure.body.bind(failure);
    failure.body = requestId => {
      const out = body(requestId);
      out.error.metadata = safe;
      out.error.message=data.code==='note_owning_entry_required'?'This note must keep an entry in its owning workspace; move it within that workspace or delete the note.':'This placement also makes the note readable by the destination Project; confirm sharing to continue.';
      return out;
    };
  }
  return failure;
}
