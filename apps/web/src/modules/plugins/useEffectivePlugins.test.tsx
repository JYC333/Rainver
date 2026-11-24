import {act,renderHook,waitFor} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {useEffectivePlugins} from './useEffectivePlugins'
import {pluginsApi} from '../../api/client'
import {announcePluginStateChanged} from './pluginStateEvents'
import {clearSessionResidue} from '../../lib/sessionResidue'
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
it('reads again at once when the Plugins page announces an enable or disable in this tab',async()=>{
 vi.mocked(pluginsApi.effective).mockResolvedValueOnce({plugins:{probe:{enabled:true}}} as never).mockResolvedValue({plugins:{probe:{enabled:false}}} as never)
 const {result}=renderHook(()=>useEffectivePlugins());await waitFor(()=>expect(result.current.isEnabled('probe')).toBe(true))
 act(()=>announcePluginStateChanged());await waitFor(()=>expect(result.current.isEnabled('probe')).toBe(false))
})
const readers=()=>[useEffectivePlugins(),useEffectivePlugins(),useEffectivePlugins()]
it('shares one read between the Shell and Project readers on mount, focus and a later mount',async()=>{
 vi.mocked(pluginsApi.effective).mockResolvedValue({plugins:{probe:{enabled:true}}} as never)
 const {result}=renderHook(readers);await waitFor(()=>expect(result.current.every(r=>r.isEnabled('probe'))).toBe(true))
 expect(pluginsApi.effective).toHaveBeenCalledTimes(1)
 await act(async()=>{window.dispatchEvent(new Event('focus'))});expect(pluginsApi.effective).toHaveBeenCalledTimes(2)
 const late=renderHook(()=>useEffectivePlugins());expect(late.result.current.isEnabled('probe')).toBe(true);expect(late.result.current.loading).toBe(false)
 await act(async()=>{});expect(pluginsApi.effective).toHaveBeenCalledTimes(2)
})
it('reads the new Space once for every reader and keeps the old Space reply out',async()=>{
 let resolveA!:(value:unknown)=>void
 vi.mocked(pluginsApi.effective).mockImplementationOnce(()=>new Promise(r=>{resolveA=r}) as never).mockResolvedValue({plugins:{probe:{enabled:false}}} as never)
 const {result,rerender}=renderHook(readers);expect(pluginsApi.effective).toHaveBeenCalledTimes(1)
 context.activeSpaceId='b';rerender();await waitFor(()=>expect(result.current[0].loading).toBe(false))
 expect(pluginsApi.effective).toHaveBeenCalledTimes(2);expect(pluginsApi.effective).toHaveBeenLastCalledWith({spaceId:'b'})
 await act(async()=>resolveA({plugins:{probe:{enabled:true}}}));expect(result.current.some(r=>r.isEnabled('probe'))).toBe(false)
})
it('a change announced during a read supersedes it instead of joining it',async()=>{
 let resolveStale!:(value:unknown)=>void
 vi.mocked(pluginsApi.effective).mockImplementationOnce(()=>new Promise(r=>{resolveStale=r}) as never).mockResolvedValueOnce({plugins:{probe:{enabled:false}}} as never)
 const {result}=renderHook(readers)
 act(()=>announcePluginStateChanged());expect(pluginsApi.effective).toHaveBeenCalledTimes(2)
 await waitFor(()=>expect(result.current[0].loading).toBe(false))
 await act(async()=>resolveStale({plugins:{probe:{enabled:true}}}));expect(result.current[1].isEnabled('probe')).toBe(false)
})
it('drops the signed-out session at once, starts no read for it and never joins or applies its reply',async()=>{
 let resolveOld!:(value:unknown)=>void
 vi.mocked(pluginsApi.effective).mockResolvedValueOnce({plugins:{probe:{enabled:true}}} as never).mockImplementationOnce(()=>new Promise(r=>{resolveOld=r}) as never).mockResolvedValue({plugins:{}} as never)
 const {result}=renderHook(readers);await waitFor(()=>expect(result.current[0].isEnabled('probe')).toBe(true))
 act(()=>result.current[0].refresh())
 act(()=>clearSessionResidue());expect(result.current.some(r=>r.isEnabled('probe'))).toBe(false)
 await act(async()=>{});expect(pluginsApi.effective).toHaveBeenCalledTimes(2)
 await act(async()=>{window.dispatchEvent(new Event('focus'))});expect(pluginsApi.effective).toHaveBeenCalledTimes(3)
 await act(async()=>resolveOld({plugins:{probe:{enabled:true}}}));expect(result.current.some(r=>r.isEnabled('probe'))).toBe(false)
 await waitFor(()=>expect(result.current[0].loading).toBe(false));expect(result.current.some(r=>r.isEnabled('probe'))).toBe(false)
})
it('retries a failed read once on the next focus and recovers every reader',async()=>{
 vi.mocked(pluginsApi.effective).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({plugins:{probe:{enabled:true}}} as never)
 const {result}=renderHook(readers);await waitFor(()=>expect(result.current[2].error).toBe('offline'))
 expect(pluginsApi.effective).toHaveBeenCalledTimes(1)
 await act(async()=>{window.dispatchEvent(new Event('focus'))});await waitFor(()=>expect(result.current.every(r=>r.isEnabled('probe')&&!r.error)).toBe(true))
 expect(pluginsApi.effective).toHaveBeenCalledTimes(2)
})
