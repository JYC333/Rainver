import {afterEach,describe,expect,it,vi} from 'vitest'
import {projectsApi,setSpaceContext} from '../api/client'
afterEach(()=>{vi.unstubAllGlobals();setSpaceContext('')})
describe('Project operation metadata pagination',()=>{
 it('keeps every operation across bounded pages and restores recency order',async()=>{
  const records=Array.from({length:101},(_,i)=>({id:`operation-${String(i).padStart(3,'0')}`,updated_at:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString()}))
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
   const url=new URL(String(input),'http://test.invalid');const after=url.searchParams.get('after_id')
   expect(url.searchParams.get('limit')).toBe('100')
   return new Response(JSON.stringify(after?records.slice(100):records.slice(0,100)),{status:200,headers:{'Content-Type':'application/json'}})
  })
  vi.stubGlobal('fetch',fetcher);setSpaceContext('space')
  const result=await projectsApi.operations('project')
  expect(result).toHaveLength(101);expect(new Set(result.map(r=>r.id)).size).toBe(101)
  expect(result[0]!.id).toBe('operation-100');expect(String(fetcher.mock.calls[1]![0])).toContain('after_id=operation-099')
 })
})
