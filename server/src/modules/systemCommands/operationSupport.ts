import type {OperationActor} from '@rainver/protocol';
import {HttpError} from '../routeUtils/common.js';
import {OperationRefusal,hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationBusinessError} from '../systemActions/operations/errors.js';
import {SystemCommandRefusal} from './intents.js';
import type {ServerConfig} from '../../config.js';
import {secretFingerprint} from '../providers/secretRefCrypto.js';

/** The person a settings command is given by (every settings operation is user-only). */
export const user=(a:OperationActor)=>a.on_behalf_of_user_id!;
/** Settings commands are a person's direct writes; nothing here is unattended. */
export const settingsPolicyContext=()=>({trigger_origin:'manual',direct_user_write:true});

/**
 * The settings block's explicit refusal classifier. A domain's deterministic
 * 400/409/422 is a person-written refusal (validation, a busy command, a
 * conflicting state) and is reflected; 403/404 stay the hidden 404 (the
 * executor maps them); anything else stays internal.
 */
const REFUSAL_NAMES=new Set(['ProviderCommandValidationError','NetworkProfileError','AcpRegistryError','DeploymentConflictError','DeploymentUnsupportedError','DeploymentDeployerOfflineError','SystemCommandRefusal']);
export function classifySettingsError(error:unknown,domain:string):OperationBusinessError|undefined{
  if(error instanceof SystemCommandRefusal)return new OperationRefusal(error.statusCode,domain,error.message,error.responseBody);
  const e=error as Error&{statusCode?:number;responseBody?:unknown;code?:string};
  if(!e||typeof e!=='object'||typeof e.statusCode!=='number')return undefined;
  if(e.statusCode===403||e.statusCode===404)return undefined;
  if(!(error instanceof HttpError)&&!REFUSAL_NAMES.has(e.name))return undefined;
  return markedRefusal({statusCode:e.statusCode,message:e.message,responseBody:e.responseBody??(typeof e.code==='string'?{code:e.code}:undefined)},domain);
}
export {hidden};

/**
 * A request fingerprint over input that may carry a secret (a Provider key,
 * or a proxy/target URL a person may have typed with credentials before
 * validation refused it): each named field becomes a keyed digest, so the
 * stored fingerprint never derives from the secret alone. The operation still
 * receives the real input.
 */
export async function keyedSecretFingerprint(config:ServerConfig,input:unknown,fields:readonly string[]):Promise<unknown>{
  const i=input as Record<string,unknown>;
  if(!fields.some(field=>typeof i[field]==='string'))return input;
  const out:Record<string,unknown>={...i};
  for(const field of fields)if(typeof out[field]==='string')out[field]=await secretFingerprint(config.rainverHome,out[field] as string);
  return out;
}
