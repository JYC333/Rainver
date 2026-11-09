import { HttpError } from '../routeUtils/common.js';

/** Only domain validation sites explicitly marked by the Experiment owner are cacheable. */
export class ExperimentMutationError extends HttpError {
  constructor(statusCode: 409 | 422, message: string) { super(statusCode, message); }
}
