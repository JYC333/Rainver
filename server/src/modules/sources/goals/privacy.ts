import {CustomSourceHandlerOutputSchema} from '@rainver/protocol';
import {applyCustomSourceRetentionPolicy} from '../customSources/customSourceMaterializer.js';
/** Calibration response bytes are private execution inputs, never a read DTO. */
export function publicGoalContribution(raw:Record<string,unknown>){
 const {fixture:_,output,...metadata}=raw;
 const parsed=CustomSourceHandlerOutputSchema.safeParse(output);
 const retention=raw.capture_policy==='reference_only'?'metadata_only':typeof raw.retention_policy==='string'?raw.retention_policy:'metadata_only';
 return {...metadata,validation:publicGoalValidation(raw.validation),...(parsed.success?{output:applyCustomSourceRetentionPolicy(parsed.data,retention)}:{})};
}
export function publicGoalValidation(raw:unknown){
 if(!raw || typeof raw!=='object')return null;
 const value=raw as Record<string,unknown>;
 return Object.fromEntries(['ok','errors','count','stable_ids','filtered_count'].filter(k=>k in value).map(k=>[k,value[k]]));
}
