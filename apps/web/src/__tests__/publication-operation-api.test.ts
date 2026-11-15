// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {publicationsApi,setSpaceContext} from '../api/client';
const response=(data:unknown,status=201)=>new Response(JSON.stringify({status:'succeeded',data}),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{setSpaceContext('target-space');vi.stubGlobal('fetch',vi.fn());});
afterEach(()=>vi.unstubAllGlobals());
it('unwraps the formal command envelope and preserves the explicit retry key for every Publication command',async()=>{
 vi.mocked(fetch).mockResolvedValueOnce(response({id:'publication',target_space_ids:['target']}));
 expect(await publicationsApi.create({resource_type:'task',resource_id:'task',target_space_ids:['target']},'create-key')).toEqual({id:'publication',target_space_ids:['target']});
 vi.mocked(fetch).mockResolvedValueOnce(response({publication_id:'publication',imported_resource_id:null}));
 expect(await publicationsApi.import('publication','import-key')).toEqual({publication_id:'publication',imported_resource_id:null});
 vi.mocked(fetch).mockResolvedValueOnce(response({id:'publication',status:'revoked'},200));
 expect(await publicationsApi.revoke('publication','revoke-key')).toEqual({id:'publication',status:'revoked'});
 const calls=vi.mocked(fetch).mock.calls;
 expect(calls.map(([url])=>String(url))).toEqual(['/api/v1/publications','/api/v1/publications/publication/import','/api/v1/publications/publication/revoke']);
 expect(calls.map(([,init])=>new Headers(init!.headers).get('Idempotency-Key'))).toEqual(['create-key','import-key','revoke-key']);
 expect(calls.map(([,init])=>JSON.parse(String(init!.body)))).toEqual([{resource_type:'task',resource_id:'task',target_space_ids:['target']},{},{}]);
});
it('surfaces a refusal without automatically retrying a write',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({error:{code:'operation_conflict',domain:'publications',message:'Snapshot revoked',metadata:{},retryable:false,request_id:'request'}}),{status:409,headers:{'Content-Type':'application/json'}}));
 await expect(publicationsApi.import('publication','same-key')).rejects.toThrow();
 expect(fetch).toHaveBeenCalledTimes(1);
});
