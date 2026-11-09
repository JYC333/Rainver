import {HttpError} from '../routeUtils/common.js';
/** Only deterministic Source planning/control refusals enter the core cache. */
export class SourceBackfillMutationError extends HttpError {}
