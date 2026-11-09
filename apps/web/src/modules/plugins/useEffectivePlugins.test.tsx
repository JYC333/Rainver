import {act,renderHook,waitFor} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {useEffectivePlugins} from './useEffectivePlugins'
import {pluginsApi} from '../../api/client'
const context=vi.hoisted(()=>({userId:'one',activeSpaceId:'a',preferredSpaceId:'a'}))
vi.mock('../../contexts/SpaceContext',()=>({useSpace:()=>context}))
vi.mock('../../api/client',()=>({pluginsApi:{effective:vi.fn()}}))
afterEach(()=>{vi.clearAllMocks();context.userId='one';context.activeSpaceId='a'})
it('withholds previous Space state immediately and discards its late response',async()=>{
 let resolveA!:(value:unknown)=>void,resolveB!:(value:unknown)=>void
 vi.mocked(pluginsApi.effective).mockImplementationOnce(()=>new Promise(r=>{resolveA=r}) as never).mockImplementationOnce(()=>new Promise(r=>{resolveB=r}) as never)
 const {result,rerender}=renderHook(()=>useEffectivePlugins())
 context.activeSpaceId='b';rerender();expect(result.current.plugins).toEqual({})
 await act(async()=>resolveA({plugins:{probe:{enabled:true}}}));expect(result.current.isEnabled('probe')).toBe(false)
 await act(async()=>resolveB({plugins:{probe:{enabled:false}}}));await waitFor(()=>expect(result.current.loading).toBe(false))
 expect(pluginsApi.effective).toHaveBeenLastCalledWith({spaceId:'b'})
})
it('clears enabled navigation on a failed refresh and account switch',async()=>{
 vi.mocked(pluginsApi.effective).mockResolvedValueOnce({plugins:{probe:{enabled:true,visible:true}}} as never).mockRejectedValueOnce(new Error('revoked')).mockResolvedValue({plugins:{}})
 const {result,rerender}=renderHook(()=>useEffectivePlugins());await waitFor(()=>expect(result.current.isEnabled('probe')).toBe(true))
 act(()=>result.current.refresh());await waitFor(()=>expect(result.current.error).toBe('revoked'));expect(result.current.plugins).toEqual({})
 context.userId='two';rerender();expect(result.current.isEnabled('probe')).toBe(false);await waitFor(()=>expect(result.current.loading).toBe(false))
})
