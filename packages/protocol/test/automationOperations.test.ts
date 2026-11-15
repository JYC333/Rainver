import {describe,expect,it} from 'vitest';
import {AUTOMATION_FIRE_OPERATION_SCHEMAS,AutomationFireRequestSchema,AUTOMATION_CONFIGURATION_OPERATION_SCHEMAS as schemas} from '../src/automationOperations.js';
const space_id='space',agent_id='agent';
describe('Automation configuration DTOs',()=>{
 it('keeps target-owned JSON fields and nullable patch semantics',()=>{
  expect(schemas['automation.create'].input.parse({space_id,agent_id,name:'Work',config_json:{target_type:'workflow',input_json:{nested:[true,null,1]},contract_json:{max_runs:1}}}).config_json).toMatchObject({contract_json:{max_runs:1}});
  expect(schemas['automation.update'].input.parse({space_id,automation_id:'automation',project_id:null,config_json:null,name:null})).toMatchObject({project_id:null,config_json:null});
 });
 it.each(Object.keys(schemas) as (keyof typeof schemas)[])('rejects unowned fields on %s',id=>{
  const input=id==='automation.create'?{space_id,agent_id,name:'Work'}:id==='automation.update'?{space_id,automation_id:'automation'}:{space_id,agent_id};
  expect(schemas[id].input.safeParse({...input,owner_user_id:'forged'}).success).toBe(false);
 });
 it.each([undefined,()=>true,Number.NaN,Number.POSITIVE_INFINITY])('refuses values outside JSON in target config: %s',value=>{
  expect(schemas['automation.create'].input.safeParse({space_id,agent_id,name:'Work',config_json:{value}}).success).toBe(false);
 });
});

describe('Automation fire DTOs',()=>{
 const schema=AUTOMATION_FIRE_OPERATION_SCHEMAS['automation.fire'];
 it('accepts only a public manual fire and a strict asynchronous receipt',()=>{
  expect(schema.input.parse({space_id,automation_id:'automation',prompt:null,instruction:'Ask'})).toMatchObject({instruction:'Ask'});
  for(const extra of [{trigger_type:'schedule'},{trigger_context:{approved:true}},{snapshot:'forged'},{worker_id:'forged'}])expect(schema.input.safeParse({space_id,automation_id:'automation',...extra}).success).toBe(false);
  expect(schema.output.parse({space_id,automation_id:'automation',job_id:'job',status:'pending'})).toMatchObject({job_id:'job'});
  expect(schema.output.safeParse({space_id,automation_id:'automation',job_id:'job',status:'pending',run_id:'premature'}).success).toBe(false);
 });
 it('validates the private result status and outcome',()=>{
  expect(AutomationFireRequestSchema.parse({status:'failed',outcome:'unknown',result:null,error:'Not repeated'}).outcome).toBe('unknown');
  expect(AutomationFireRequestSchema.safeParse({status:'complete',outcome:'completed',result:{},error:null}).success).toBe(false);
 });
});
