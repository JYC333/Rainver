import type {SourceGoalBindingSpec} from '@rainver/protocol';

const RETRYABLE_NATIVE_ERRORS=new Set([
 'source_native_failed','source_native_deadline_exceeded','source_native_cancelled',
 'source_material_failed','source_material_unavailable','source_native_output_invalid',
]);
/** Only an explicit owner check may retry failed native execution. Provider
 * cooldowns, repair, access, setup and budget decisions are not retry authority. */
export function retryableNativeCollection(binding:{status:string;spec_json:SourceGoalBindingSpec;fixture_json?:{collection_error?:string}|null}){
 return binding.spec_json.implementation.kind==='agent_search'
  && ['cooldown','paused'].includes(binding.status)
  && RETRYABLE_NATIVE_ERRORS.has(binding.fixture_json?.collection_error??'');
}
