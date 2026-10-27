// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { informationDigestsApi, setSpaceContext } from '../../../api/client'
afterEach(()=>vi.unstubAllGlobals())
it('forwards AbortSignal to fetch and binds the explicit reading Space',async()=>{
  const controller=new AbortController()
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({items:[],total:0,next_cursor:null})})
  vi.stubGlobal('fetch',fetch)
  setSpaceContext('another-space')
  await informationDigestsApi.reading('reading-space',{q:'final phrase'},undefined,{signal:controller.signal})
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/spaces/reading-space/reading?'),expect.objectContaining({signal:controller.signal,headers:expect.objectContaining({'X-Rainver-Space-Id':'reading-space'})}))
})
it('propagates transport cancellation rather than treating it as a successful empty page',async()=>{
  const controller=new AbortController()
  vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})})))
  const pending=informationDigestsApi.reading('reading-space',{},undefined,{signal:controller.signal})
  controller.abort()
  await expect(pending).rejects.toMatchObject({name:'AbortError'})
})
