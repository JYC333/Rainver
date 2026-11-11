import {HttpError} from '../routeUtils/common.js';
/** A deterministic refusal to claim a Host thread for a conversation turn
 * (busy, offline, unbound or mismatched target). The operation core classifies
 * only these; other HttpErrors from the same path stay internal or hidden. */
export class HostDispatchRefusal extends HttpError {
  constructor(statusCode:409|422,message:string,body?:unknown){super(statusCode,message,body);this.name='HostDispatchRefusal';}
}
/** A deterministic Agent group refusal written for the person (validation, state conflict). */
export class AgentGroupRefusal extends HttpError {
  constructor(statusCode:409|422,message:string,body?:unknown){super(statusCode,message,body);this.name='AgentGroupRefusal';}
}
