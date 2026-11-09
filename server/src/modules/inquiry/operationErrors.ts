import {HttpError} from '../routeUtils/common.js';
/** Known domain validation sites, never an allowlist for arbitrary helper errors. */
export class InquiryMutationError extends HttpError {
 constructor(status:409|422,message:string){super(status,message);}
}

/** Original per-turn Task creation ceiling; not a storage/internal failure. */
export class InquiryTaskFanOutError extends HttpError {
 constructor(){super(429,'This turn reached the ordinary Task creation ceiling; use an explicitly requested bounded batch for a list');}
}
