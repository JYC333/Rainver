import {HttpError} from '../routeUtils/common.js';
/** Only deterministic binding validation/conflicts are cacheable core failures. */
export class ProjectSourceMutationError extends HttpError {}
