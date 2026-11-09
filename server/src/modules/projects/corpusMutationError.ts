import {HttpError} from '../routeUtils/common.js';
export class ProjectCorpusMutationError extends HttpError{
 constructor(statusCode:409|422,message:string){super(statusCode,message);}
}
/** Keep the owning service's validation shape; public core admission hides it. */
export class ProjectCorpusReferenceUnavailable extends ProjectCorpusMutationError{
 constructor(message:string){super(422,message);}
}
