import {HttpError} from '../routeUtils/common.js';
/** Only explicit canonical refusal sites opt in; HTTP status alone is not a classifier. */
export class CodePatchDecisionRefusal extends HttpError {}
