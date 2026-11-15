import {HttpError} from '../routeUtils/common.js';
/** Explicit, person-safe Source refusals raised at their owning throw sites
 * (items/evidence, material processing, post-processing, retrieval, recipes,
 * Custom Sources and goals). Only these are cached by the operation core; any
 * other 409/422 stays internal. `metadata` is a structured, content-free body
 * (for example `{code}`) the person-facing client may act on. */
export class SourceObjectRefusal extends HttpError {
  constructor(statusCode:409|422,message:string,metadata?:Record<string,unknown>){super(statusCode,message,metadata);this.name='SourceObjectRefusal';}
}
