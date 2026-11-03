import {CustomSourceHandlerOutputSchema,type SourceMaterialSubmission,type SourceGoalBudget} from '@rainver/protocol';
import {agentReadingMetadata} from '../materialProcessing/documents.js';
import {validateGoalSample} from './validation.js';
import type {GoalRow} from './access.js';

/** Convert only the bounded Agent submission. No fetching, item writes or claims
 * of verified retrieval. Live item caps belong to the shared membership selector. */
export function prepareCollectionResult(submission:SourceMaterialSubmission,input:{
 runId:string;method:unknown;intent:GoalRow['intent_json'];excludedOrigins:string[];
 budget:SourceGoalBudget;preview:boolean;
}){
 const unique=new Map(submission.items.map(item=>[new URL(item.url).href,item]));
 const stated=(time:string|null|undefined)=>time&&Number.isFinite(Date.parse(time))&&Date.parse(time)<=Date.now()+5*60_000?new Date(time).toISOString():null;
 const raw=CustomSourceHandlerOutputSchema.parse({
  contract_version:'custom_source.handler_output.v1',
  items:[...unique].map(([url,item])=>({
   external_id:url,source_uri:url,title:item.title,published_at:stated(item.published_at),
   excerpt:item.summary,reading_content:item.content,snapshots:[],evidence:[],
   metadata:{
    ...(item.content?agentReadingMetadata(item.content):item.summary?{reading_content_kind:'other',reading_content_format:'agent_summary',reading_sources:[url]}:{}),
    reading_unavailable_reason:item.content?null:item.unavailable_reason??'not_read',
    agent_run_id:input.runId,reading_method_provenance:input.method,
    observed_at:item.observed_at,result_provenance:'agent_provided_unverified',
   },
  })),
 });
 const scoped={...raw,items:raw.items.filter(item=>!input.excludedOrigins.some(origin=>new URL(origin).origin===new URL(item.source_uri).origin))};
 const validation=validateGoalSample(scoped,{allowUndated:true,allowEmpty:!input.preview,budget:input.budget,...input.intent});
 const insufficient=input.preview&&!validation.count&&validation.errors.every(error=>error==='empty_result');
 if(!validation.ok&&!insufficient)throw new Error('source_native_output_invalid');
 const checked=CustomSourceHandlerOutputSchema.parse(validation.output);
 const returned=input.preview?checked.items.slice(0,input.budget.items_per_source):checked.items;
 const signals={items:Object.fromEntries([...unique].map(([url,item])=>[url,{judgment:item.topic_judgment??null,change:item.change??null}])),judgment_failure:submission.judgment_failure?.message??null};
 return {
  output:{...checked,items:returned},topicSignals:signals,validation,insufficient,
  coverage:{observed_items:submission.items.length,unique_items:unique.size,eligible_items:checked.items.length,
   ...(input.preview?{returned_items:returned.length,truncated:submission.coverage.truncated||returned.length<checked.items.length}:{}),
  },
  selection:{observed_count:raw.items.length,filtered_count:raw.items.length-checked.items.length,selected_count:returned.length,remaining_count:checked.items.length-returned.length},
 };
}
