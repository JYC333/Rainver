import { HttpError } from '../routeUtils/common.js';
import {OperationBusinessError} from '../systemActions/operations/errors.js';
export class ProjectFolderMutationError extends HttpError {
  constructor(statusCode: 409 | 422, message: string) { super(statusCode, message); }
}
/** Explicit draft/registration refusal sites; private draft bodies are never error metadata. */
export class ProjectFolderRefusal extends HttpError {
  constructor(statusCode:409|413|422,message:string,readonly metadata:Record<string,unknown>){super(statusCode,message,{detail:message,...metadata});}
}
/** Typed file/policy refusal sites retain their legacy read envelope; workers use only safeCode. */
export class ProjectFolderFileRefusal extends HttpError{
  constructor(status:number,message:string,readonly safeCode:string,body?:unknown){super(status,message,body);}
}
export function projectFolderRefusal(error:unknown):OperationBusinessError|undefined{
  if(!(error instanceof ProjectFolderRefusal))return undefined;
  const result=new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'project_folders'),body=result.body.bind(result);
  result.body=requestId=>{const output=body(requestId);output.error.metadata=error.metadata;output.error.message=error.message;return output;};
  return result;
}
