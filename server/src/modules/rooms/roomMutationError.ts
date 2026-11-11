import {HttpError} from '../routeUtils/common.js';
/** A deterministic Room refusal written for the person; the operation core may
 * reflect its message and structured body. Any other HttpError stays internal or hidden. */
export class RoomMutationError extends HttpError {
  constructor(statusCode:409|422,message:string,body?:unknown){super(statusCode,message,body);this.name='RoomMutationError';}
}
/** Carries a typed lower-level refusal into the Room vocabulary: 409/422 stay
 * marked and readable; any other status keeps its plain (unclassified) HttpError. */
export function roomRefusal(statusCode:number,message:string,body?:unknown):HttpError{
  return statusCode===409||statusCode===422?new RoomMutationError(statusCode,message,body):new HttpError(statusCode,message,body);
}
