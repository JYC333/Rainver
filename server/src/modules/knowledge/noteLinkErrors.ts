import {HttpError} from '../routeUtils/common.js';
/** Person-safe Note link/jot refusals raised at their owning throw sites; the
 * only Note link failures the operation core caches. */
export class NoteLinkRefusal extends HttpError {
  constructor(statusCode:409|422,message:string,details?:Record<string,unknown>){super(statusCode,message,details);this.name='NoteLinkRefusal';}
}
