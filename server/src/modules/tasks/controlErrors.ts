import {HttpError} from '../routeUtils/common.js';
/** Explicit domain refusal allowlist for Task control commands. */
export class TaskControlError extends HttpError {}
