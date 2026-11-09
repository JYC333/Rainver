import {HttpError} from '../routeUtils/common.js';
/** Only deterministic failures raised at the workspace domain validation sites. */
export class ResearchWorkspaceMutationError extends HttpError {
  constructor(statusCode:409|422,message:string){super(statusCode,message);}
}
/** Mandatory B11 failure is transient and must never become a cached command result. */
export class ResearchContentReadAuditError extends HttpError {
  constructor(){super(503,'Research content-read audit unavailable');}
}
