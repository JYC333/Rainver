import {HttpError} from '../routeUtils/common.js';
/** Only the actual object-profile compiler's deterministic validation refusal. */
export class KnowledgeProfileValidationError extends HttpError {
 constructor(message:string){super(422,message);}
}
