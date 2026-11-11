import {it,expect} from 'vitest';
import {RESEARCH_CONTROL_SCHEMAS,RESEARCH_TRIGGER_MAX_SOURCE_ITEMS} from '../src/researchControlOperations.js';

const trigger=RESEARCH_CONTROL_SCHEMAS['research.workflow.trigger'].input;
it('accepts an explicit empty trigger item list as the scan-first form and keeps the list bounded',()=>{
 expect(trigger.parse({project_id:'p',workflow_id:'w',source_item_ids:[]})).toEqual({project_id:'p',workflow_id:'w',source_item_ids:[]});
 expect(trigger.parse({project_id:'p',workflow_id:'w'})).toEqual({project_id:'p',workflow_id:'w'});
 expect(trigger.safeParse({project_id:'p',workflow_id:'w',source_item_ids:Array.from({length:RESEARCH_TRIGGER_MAX_SOURCE_ITEMS},(_,i)=>`i${i}`)}).success).toBe(true);
 expect(trigger.safeParse({project_id:'p',workflow_id:'w',source_item_ids:Array.from({length:RESEARCH_TRIGGER_MAX_SOURCE_ITEMS+1},(_,i)=>`i${i}`)}).success).toBe(false);
 expect(trigger.safeParse({project_id:'p',workflow_id:'w',source_item_ids:['']}).success).toBe(false);
});
