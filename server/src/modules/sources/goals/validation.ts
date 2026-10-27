import {CustomSourceHandlerOutputSchema,type SourceGoalBudget} from '@rainver/protocol';
export function goalItemRelevant(i:{title:string;excerpt?:string|null},options:{includes:string[];excludes:string[]}){const text=(i.title+' '+(i.excerpt??'')).toLowerCase();return !options.excludes.some(t=>text.includes(t.toLowerCase()))&&(!options.includes.length||options.includes.some(t=>text.includes(t.toLowerCase())));}
/** Semantic gate in addition to the canonical materializer's filesystem/schema validation. */
export function validateGoalSample(raw:unknown,options:{budget:SourceGoalBudget;includes:string[];excludes:string[];baselineIds?:string[];allowEmpty?:boolean}){
 const parsed=CustomSourceHandlerOutputSchema.safeParse(raw);const errors:string[]=[];
 if(!parsed.success)return {ok:false,errors:['source_output_invalid'],count:0,stable_ids:[] as string[],filtered_count:0,output:raw};
 const all=parsed.data.items;const items=all.filter(i=>goalItemRelevant(i,options));const ids=items.map(i=>i.external_id);
 if(!items.length && !options.allowEmpty)errors.push('empty_result');
 if(new Set(items.map(i=>i.source_uri)).size!==items.length)errors.push('duplicate_source_uri');
 if(new Set(ids).size!==ids.length)errors.push('duplicate_stable_id');
 for(const i of items){
  if(!i.external_id.trim() || !i.title.trim() || !/^https?:\/\//.test(i.source_uri) || !i.published_at || !Number.isFinite(Date.parse(i.published_at)))errors.push('missing_identity_time_or_link');

 }
 if(options.baselineIds?.length){
  const overlap=ids.filter(id=>options.baselineIds!.includes(id)).length;
  if(overlap/options.baselineIds.length<0.5)errors.push('stable_identity_drift');
  if(items.length>Math.max(3,options.baselineIds.length*3))errors.push('abnormal_quantity');
 }
 return {ok:errors.length===0,errors:[...new Set(errors)],count:items.length,stable_ids:ids,filtered_count:all.length-items.length,output:{...parsed.data,items}};
}
