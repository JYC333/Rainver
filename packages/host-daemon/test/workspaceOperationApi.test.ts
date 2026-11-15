import {afterEach,expect,it,vi} from 'vitest';
import {createWorkspace,removeWorkspace} from '../src/api.js';
afterEach(()=>vi.unstubAllGlobals());
const data={id:'location',space_id:'space',project_id:'project',folder_id:'folder',name:'Repo',display_path:'/local',host_kind:'remote',root_path:null,registered_from:'daemon_registered',created_at:'2026-11-14T00:00:00.000Z'};
it('uses the Host bearer, explicit keys and strict envelopes without changing the Location id',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data}),{status:201})).mockResolvedValueOnce(new Response(JSON.stringify({status:'succeeded',data:{id:'location',space_id:'space',project_id:'project',folder_id:'folder',host_id:'host',removed:true}})));
 vi.stubGlobal('fetch',fetcher);
 expect(await createWorkspace('https://control','token',{projectId:'project',name:'Repo',displayPath:'/local'},'create-key')).toEqual(data);
 await expect(removeWorkspace('https://control','token','location','remove-key')).resolves.toBeUndefined();
 const calls=fetcher.mock.calls;
 expect(calls.map(([url])=>url)).toEqual(['https://control/api/v1/hosts/me/workspaces','https://control/api/v1/hosts/me/workspaces/location']);
 expect(calls.map(([,init])=>init.headers)).toEqual([{'content-type':'application/json',authorization:'Bearer token','idempotency-key':'create-key'},{'content-type':'application/json',authorization:'Bearer token','idempotency-key':'remove-key'}]);
 expect(calls.every(([,init])=>init.redirect==='error')).toBe(true);
});
it('surfaces refusal once without replaying the write',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'operation_conflict',message:'conflict',retryable:false}}),{status:409}));vi.stubGlobal('fetch',fetcher);
 await expect(removeWorkspace('https://control','token','location','key')).rejects.toMatchObject({statusCode:409,code:'operation_conflict',retryable:false});expect(fetcher).toHaveBeenCalledTimes(1);
});
it('refuses malformed successful receipts',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'succeeded',data:{ok:true}}))));
 await expect(removeWorkspace('https://control','token','location','key')).rejects.toThrow();
});
