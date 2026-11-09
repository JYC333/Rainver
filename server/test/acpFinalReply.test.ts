import {describe,expect,it} from 'vitest';
import {createCliConversationController} from '../src/modules/runs/cliConversationProtocol.js';

function answer(updates:Record<string,unknown>[]){
 const deltas:string[]=[];
 const c=createCliConversationController({runtime_key:'opencode',cwd:'/workspace',prompt:'review',on_text_delta:t=>deltas.push(t)})!;
 const send=()=>{};
 c.start(send);
 c.receive({jsonrpc:'2.0',id:1,result:{protocolVersion:1}},send,send);
 c.receive({jsonrpc:'2.0',id:2,result:{sessionId:'s1'}},send,send);
 for(const update of updates)c.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s1',update}},send,send);
 c.receive({jsonrpc:'2.0',id:4,result:{stopReason:'end_turn'}},send,send);
 return {result:c.result(),deltas};
}
const chunk=(text:string,messageId?:string)=>({sessionUpdate:'agent_message_chunk',content:{type:'text',text},...(messageId?{messageId}:{})});
describe('ACP final reply',()=>{
 it('keeps only the last identified message while streaming all progress',()=>{
  const {result,deltas}=answer([chunk('Checking now.','progress'),chunk('Fixed ','final'),chunk('and checked.','final')]);
  expect(result).toMatchObject({completed:true,error:null,text:'Fixed and checked.'});
  expect(deltas.join('')).toBe('Checking now.Fixed and checked.');
 });
 it('separates anonymous progress from the answer after actual tool work',()=>{
  expect(answer([chunk('Checking now.'),{sessionUpdate:'tool_call',toolCallId:'read',title:'Read',status:'completed'},chunk('Fixed '),chunk('and checked.')]).result).toMatchObject({text:'Fixed and checked.'});
 });
 it('does not split one answer on usage updates or erase it when the last tool has no closing prose',()=>{
  expect(answer([chunk('One '),{sessionUpdate:'usage_update',used:1,size:100},chunk('answer'),{sessionUpdate:'tool_call',toolCallId:'read',title:'Read',status:'completed'}]).result).toMatchObject({text:'One answer'});
 });
});
