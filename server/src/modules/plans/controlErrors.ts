import {HttpError} from '../routeUtils/common.js';
/** Explicit, person-safe Plan execution refusals (static messages only). */
export class PlanControlError extends HttpError {}
