import {it,expect} from 'vitest';
import {PROJECT_CORPUS_SCHEMAS,SYSTEM_ACTION_REGISTRY} from '../src/index.js';
it('requires one typed Corpus target, keeps nullable editor state and rejects forged authority or result bodies',()=>{
 const input=PROJECT_CORPUS_SCHEMAS['project.corpus.upsert'].input;
 expect(input.parse({project_id:'p',source_item_id:'s',reason:'  Note  ',confidence:''})).toMatchObject({reason:'Note',confidence:null});
 expect(input.safeParse({project_id:'p',source_item_id:'s',object_id:'o'}).success).toBe(false);
 expect(input.safeParse({project_id:'p',source_item_id:'s',owner_user_id:'forged'}).success).toBe(false);
 for(const id of Object.keys(PROJECT_CORPUS_SCHEMAS) as (keyof typeof PROJECT_CORPUS_SCHEMAS)[]){const definition=SYSTEM_ACTION_REGISTRY.find(d=>d.id===id)!;expect(definition.allowed_actor_types).toEqual(['user']);expect(definition.grantable).toBe(false);expect(definition.visibility.has('agent_tool')).toBe(false);expect(PROJECT_CORPUS_SCHEMAS[id].output.safeParse({id:'i',project_id:'p',space_id:'s',excerpt:'PRIVATE'}).success).toBe(false);}
});
