import {HttpError} from '../routeUtils/common.js';
/** Only named deterministic domain refusals are eligible for durable command receipts. */
export class ProjectManagementMutationError extends HttpError {}
