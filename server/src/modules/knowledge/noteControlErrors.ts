import {HttpError} from '../routeUtils/common.js';
/** Explicit safe optimistic-concurrency conflict; never caches arbitrary errors. */
export class NoteMutationConflict extends HttpError {
  constructor(message:string){super(409,message);}
}
