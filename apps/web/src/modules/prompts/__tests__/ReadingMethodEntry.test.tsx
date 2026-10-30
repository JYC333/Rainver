import i18n from '../../../i18n'
import {render,screen,waitFor,act} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi} from 'vitest'
import {ReadingMethodEntry} from '../ReadingMethodEntry'
import {clearSessionResidue} from '../../../lib/sessionResidue'
import {readingMethodsApi} from '../../../api/client'
let space='s',user='u'
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:space,userId:user})}))
vi.mock('../../../api/client',()=>({readingMethodsApi:{entry:vi.fn()}}))
it('20 actual entries share one mounted scope request, two scopes stay separate; logout clears and late replies do not resurrect',async()=>{
 vi.mocked(readingMethodsApi.entry).mockResolvedValue({can_manage:true,project_id:'p'})
 const view=render(<MemoryRouter>{Array.from({length:20},(_,n)=><ReadingMethodEntry key={n} itemId={`i${n}`} projectId="p"/>)}</MemoryRouter>)
 await waitFor(()=>expect(screen.getAllByRole('link',{name:'Improve result: adjust the reading method for this item'})).toHaveLength(20));expect(readingMethodsApi.entry).toHaveBeenCalledTimes(1)
 view.rerender(<MemoryRouter><ReadingMethodEntry key={0} itemId="i0" projectId="p"/><ReadingMethodEntry key="q" itemId="b" projectId="q"/></MemoryRouter>);await waitFor(()=>expect(readingMethodsApi.entry).toHaveBeenCalledTimes(2))
 await act(async()=>clearSessionResidue());expect(screen.queryByRole('link')).toBeNull();view.unmount()
 let finish!:(v:{can_manage:boolean;project_id:string|null})=>void;vi.mocked(readingMethodsApi.entry).mockReturnValue(new Promise(r=>finish=r));const later=render(<MemoryRouter><ReadingMethodEntry itemId="late" projectId="p"/></MemoryRouter>);await act(async()=>clearSessionResidue());await act(async()=>finish({can_manage:true,project_id:'p'}));expect(screen.queryByRole('link')).toBeNull();later.unmount()
 vi.mocked(readingMethodsApi.entry).mockRejectedValue(Object.assign(new Error('denied'),{status:403}));render(<MemoryRouter><ReadingMethodEntry itemId="denied" projectId="p"/></MemoryRouter>);await act(async()=>{});expect(screen.queryByRole('link')).toBeNull()
})

it('Space/login replacement cannot receive the old scope response or rejection',async()=>{
 const replies:Array<(v:{can_manage:boolean;project_id:string|null})=>void>=[];vi.mocked(readingMethodsApi.entry).mockImplementation(()=>new Promise(r=>replies.push(r)));
 const view=render(<MemoryRouter><ReadingMethodEntry itemId="i" projectId="p"/></MemoryRouter>);space='s2';user='u2';view.rerender(<MemoryRouter><ReadingMethodEntry itemId="i" projectId="p"/></MemoryRouter>);
 await act(async()=>replies[1]!({can_manage:true,project_id:'p'}));expect(screen.getByRole('link')).toBeInTheDocument();await act(async()=>replies[0]!({can_manage:false,project_id:'p'}));expect(screen.getByRole('link')).toBeInTheDocument();view.unmount();space='s';user='u';
});

it('both locales keep the visible label at the start of the accessible name',async()=>{
 vi.mocked(readingMethodsApi.entry).mockResolvedValue({can_manage:true,project_id:'p'});
 try{for(const locale of ['en','zh-CN']){await act(async()=>{await i18n.changeLanguage(locale)});const view=render(<MemoryRouter><ReadingMethodEntry itemId="a" projectId="p"/></MemoryRouter>);const label=locale==='en'?'Improve result':'改进结果';const link=await screen.findByRole('link',{name:new RegExp('^'+label)});expect(link.textContent).toBe(label);expect(link.getAttribute('aria-label')?.startsWith(link.textContent!)).toBe(true);expect(link).toHaveAttribute('href',expect.stringContaining('item_id=a'));view.unmount()}}
 finally{await act(async()=>{await i18n.changeLanguage('en')})}
});
