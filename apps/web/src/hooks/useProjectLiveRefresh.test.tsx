import {act,cleanup,render} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {useProjectLiveRefresh} from './useProjectLiveRefresh'
import {projectsApi} from '../api/client'
vi.mock('../api/client',async()=>{const {ApiRequestError}=await import('../test/apiClientMock');return {ApiRequestError,projectsApi:{streamUpdates:vi.fn()}}})
let emit:(frame:{type:'ready'|'changed'|'denied'})=>void
let signal:AbortSignal|undefined
function Watch({refresh}:{refresh:()=>void|Promise<void>}){useProjectLiveRefresh('p',refresh);return null}
const show=(...reads:Array<()=>void|Promise<void>>)=>render(<MemoryRouter>{reads.map((read,i)=><Watch key={i} refresh={read}/>)}</MemoryRouter>)
beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks()
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
 vi.mocked(projectsApi.streamUpdates).mockImplementation(async(_project,callback,options)=>{
  emit=callback;signal=options?.signal
  await new Promise<void>(resolve=>options?.signal?.addEventListener('abort',()=>resolve(),{once:true}))
 })
})
afterEach(()=>{cleanup();vi.useRealTimers()})
it('shares one connection, collapses bursts and makes no refresh queries while idle',async()=>{
 const a=vi.fn(),b=vi.fn(),view=show(a,b)
 expect(projectsApi.streamUpdates).toHaveBeenCalledTimes(1)
 await act(()=>vi.advanceTimersByTimeAsync(60000));expect(a).not.toHaveBeenCalled();expect(b).not.toHaveBeenCalled()
 await act(async()=>{for(let i=0;i<30;i++)emit({type:'changed'});await vi.advanceTimersByTimeAsync(150)})
 expect(a).toHaveBeenCalledTimes(1);expect(b).toHaveBeenCalledTimes(1)
 view.unmount();expect(signal?.aborted).toBe(true)
})
it('serializes refreshes and folds intervening events into one catch-up read',async()=>{
 let finish!:()=>void;const read=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve})).mockResolvedValue(undefined)
 show(read)
 await act(async()=>{emit({type:'changed'});await vi.advanceTimersByTimeAsync(150)})
 await act(async()=>{emit({type:'changed'});emit({type:'changed'});await vi.advanceTimersByTimeAsync(150)})
 expect(read).toHaveBeenCalledTimes(1)
 await act(async()=>{finish()});expect(read).toHaveBeenCalledTimes(2)
})
it('pauses hidden tabs and revalidates once on return or focus instead of polling',async()=>{
 const read=vi.fn();show(read)
 await act(async()=>{Object.defineProperty(document,'visibilityState',{value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))})
 expect(signal?.aborted).toBe(true)
 await act(()=>vi.advanceTimersByTimeAsync(60000));expect(read).not.toHaveBeenCalled()
 await act(async()=>{Object.defineProperty(document,'visibilityState',{value:'visible'});document.dispatchEvent(new Event('visibilitychange'));emit({type:'ready'});await vi.advanceTimersByTimeAsync(150)})
 expect(projectsApi.streamUpdates).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledTimes(1)
 await act(async()=>{window.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(150)})
 expect(read).toHaveBeenCalledTimes(2)
})
it('reconnects with backoff and only catches up on ready, and stops after an authorization refusal',async()=>{
 const {ApiRequestError}=await import('../api/client')
 vi.mocked(projectsApi.streamUpdates).mockRejectedValueOnce(new Error('disconnected'))
 const read=vi.fn();show(read)
 await act(()=>vi.advanceTimersByTimeAsync(1));expect(read).not.toHaveBeenCalled()
 await act(()=>vi.advanceTimersByTimeAsync(2000));expect(projectsApi.streamUpdates).toHaveBeenCalledTimes(2)
 await act(async()=>{emit({type:'ready'});await vi.advanceTimersByTimeAsync(150)})
 expect(read).toHaveBeenCalledTimes(1)
 cleanup()
 vi.mocked(projectsApi.streamUpdates).mockRejectedValueOnce(new ApiRequestError('denied',403))
 show(read)
 await act(()=>vi.advanceTimersByTimeAsync(60000))
 expect(projectsApi.streamUpdates).toHaveBeenCalledTimes(3)
})
it('aborts subscriptions on logout and cannot deliver an old session event',async()=>{
 const {clearSessionResidue}=await import('../lib/sessionResidue')
 const read=vi.fn();show(read)
 await act(async()=>{clearSessionResidue();emit({type:'changed'});await vi.advanceTimersByTimeAsync(150)})
 expect(signal?.aborted).toBe(true);expect(read).not.toHaveBeenCalled()
})
