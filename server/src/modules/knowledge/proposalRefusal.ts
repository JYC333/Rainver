import {HttpError} from '../routeUtils/common.js';
import {OperationRefusal} from '../systemActions/operations/errors.js';
/** A deterministic input/transition refusal raised by a canonical Knowledge
 * proposal writer itself (the same text its retained REST entry returned).
 * Only the writers' own 400/422 results are marked; 403/404 stay hidden. */
export class KnowledgeProposalRefusal extends HttpError {}
export async function proposalWriter<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){if(error instanceof HttpError&&(error.statusCode===400||error.statusCode===422))throw new KnowledgeProposalRefusal(422,error.message);throw error;}}
export function classifyProposalRefusal(error:unknown){return error instanceof KnowledgeProposalRefusal?new OperationRefusal(422,'knowledge',error.message):undefined;}
