import {HttpError} from '../../routeUtils/common.js';
/** Deterministic validation at the canonical monitoring control writers. */
export class MonitoringControlError extends HttpError {
 constructor(statusCode:409|422,message:string){super(statusCode,message);}
}
