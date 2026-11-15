// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {focusAreasApi,learningApi,setSpaceContext} from '../api/client';
beforeEach(()=>{setSpaceContext('space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it.each(['focus','objective','item','review'])('uses the canonical keyed %s command and unwraps its domain result',async kind=>{
 const data=kind==='focus'?{space_id:'space',object_id:'object',focus_area_id:null}:kind==='objective'?{space_id:'space',objective:{id:'objective'}}:kind==='item'?{space_id:'space',item:{id:'item'}}:{space_id:'space',mastery:{correct_streak:1}};
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data}),{status:200,headers:{'Content-Type':'application/json'}}));
 if(kind==='focus')expect(await focusAreasApi.setForObject('object',null,'same-key')).toBeUndefined();
 if(kind==='objective')expect(await learningApi.createObjective({project_id:'project',title:'Learn'},'same-key')).toEqual({id:'objective'});
 if(kind==='item')expect(await learningApi.createItem({project_id:'project',knowledge_item_id:'knowledge',item_kind:'card',prompt:'Q',answer:'A'},'same-key')).toEqual({id:'item'});
 if(kind==='review')expect(await learningApi.review('item','correct','same-key')).toEqual({correct_streak:1});
 const [url,init]=vi.mocked(fetch).mock.calls[0]!;
 expect(url).toBe('/api/v1/actions/'+({focus:'focus_area.object.set',objective:'learning.objective.create',item:'learning.item.create',review:'learning.item.review'}[kind]));expect(new Headers(init!.headers).get('Idempotency-Key')).toBe('same-key');
 expect(JSON.parse(String(init!.body))).not.toHaveProperty('user_id');
});
