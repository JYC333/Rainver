import {afterEach,expect,it,vi} from 'vitest';
import {authApi,setSpaceContext} from '../api/client';
afterEach(()=>{vi.unstubAllGlobals();setSpaceContext('');});
it('unwraps account command receipts and sends explicit keys to retained URLs',async()=>{
 setSpaceContext('unrelated-space');
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify({status:'succeeded',data:{user_id:'target',ok:true}}))));vi.stubGlobal('fetch',fetcher);
 expect(await authApi.adminDisableUser('target','disable-key')).toEqual({user_id:'target',ok:true});
 expect(await authApi.adminEnableUser('target','enable-key')).toEqual({user_id:'target',ok:true});
 expect(fetcher.mock.calls.map(([url,init])=>({url,key:new Headers(init.headers).get('Idempotency-Key')}))).toEqual([{url:'/api/v1/auth/admin/users/target/disable',key:'disable-key'},{url:'/api/v1/auth/admin/users/target/enable',key:'enable-key'}]);
});
it('returns core refusals without resubmission',async()=>{
 const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({status:'failed',error:{code:'operation_invalid_input',message:'pending registration',retryable:false}}),{status:422}));vi.stubGlobal('fetch',fetcher);
 await expect(authApi.adminEnableUser('pending','key')).rejects.toMatchObject({status:422,code:'operation_invalid_input'});expect(fetcher).toHaveBeenCalledTimes(1);
});
