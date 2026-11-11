import {HttpError} from '../routeUtils/common.js';
/** A deterministic Agent definition/Runtime Profile validation failure or state
 * conflict. Only these sites are classified by the operation core; any other
 * HttpError remains an uncached internal or hidden failure. */
export class AgentMutationError extends HttpError {
  constructor(statusCode:400|409|422,message:string){super(statusCode,message);this.name='AgentMutationError';}
}
