import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {ConversationUsage,usageAccounts} from './ConversationUsage'
import i18n from '../../i18n'
import {hostsApi} from '../../api/client'
vi.mock('../../api/client',()=>({hostsApi:{refreshUsage:vi.fn()}}))
vi.mock('../../contexts/SpaceContext',()=>({useSpace:()=>({spaceId:'space-1',activeSpaceId:'space-1'})}))
const now=new Date().toISOString()
const login=(key:string,ids:string[],pct:number)=>({login_key:key,pool_key:'shared-account',account_label:'Shared account',agent_ids:ids,checked_at:now,window:{kind:'week' as const,utilization:pct,resets_at:null},windows:[{kind:'week' as const,utilization:pct,resets_at:null,checked_at:now}]})
const quota={warn_pct:70,reserve_pct:90,holds:[],logins:[login('a',['a'],80),login('b',['b'],80)]}
beforeEach(()=>{sessionStorage.clear();vi.clearAllMocks();vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()}))})
it('groups copies by canonical account and unions their Agents without adding percentages',()=>{
 const accounts=usageAccounts(quota.logins)
 expect(accounts).toHaveLength(1);expect([...accounts[0].agents]).toEqual(['a','b']);expect(accounts[0].windows.get('week')?.utilization).toBe(80)
 expect(usageAccounts([login('a',['a'],80),{...login('b',['b'],20),pool_key:'other'}])).toHaveLength(2)
})
it('keeps usage reachable after warnings are closed and shows one row per account',async()=>{
 const refresh=vi.fn()
 render(<MemoryRouter><ConversationUsage quota={quota} selectedAgents={['a']} agents={[]} scope={{spaceId:'space-1'}} userId="u" onRefresh={refresh}/></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:'Usage: 80% used'}))
 expect(await screen.findByText('Shared account')).toBeInTheDocument();expect(screen.getByText('2 Agents share this account')).toBeInTheDocument()
 expect(screen.getByText('80% used')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Refresh account'})).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Show percentage on the button'}));expect(screen.getByRole('button',{name:'Usage: 80% used'})).not.toHaveTextContent('80%')
 expect(refresh).toHaveBeenCalledTimes(1)
})
it('does not substitute unrelated account usage for a selected recipient with no reading',()=>{
 render(<MemoryRouter><ConversationUsage quota={quota} selectedAgents={['other']} agents={[]} scope={{}} userId="u" onRefresh={()=>{}}/></MemoryRouter>)
 expect(screen.getByRole('button',{name:'Usage: No current reading'})).toHaveTextContent('—')
})
it('refreshes only through an authorized target with the explicit source Space',async()=>{
 vi.mocked(hostsApi.refreshUsage).mockResolvedValue({} as never)
 const refresh=vi.fn(),scope={spaceId:'source-space'}
 render(<MemoryRouter><ConversationUsage quota={{...quota,logins:[{...quota.logins[0],refresh_target:{host_id:'host',runtime_key:'claude_code',installation:'own'}}]}} selectedAgents={['a']} agents={[]} scope={scope} userId="u" onRefresh={refresh}/></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:'Usage: 80% used'}));fireEvent.click(await screen.findByRole('button',{name:'Refresh account'}))
 await waitFor(()=>expect(hostsApi.refreshUsage).toHaveBeenCalledWith('host','claude_code','own',undefined,scope));await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(2))
})

it('renders only measured windows, keeps zero and removes the visible Usage label',async()=>{
 render(<MemoryRouter><ConversationUsage quota={{...quota,logins:[login('a',['a'],0)]}} selectedAgents={['a']} agents={[]} scope={{}} userId="u" onRefresh={()=>{}}/></MemoryRouter>)
 const trigger=screen.getByRole('button',{name:'Usage: 0% used'})
 expect(trigger).toHaveTextContent('0%');expect(trigger).not.toHaveTextContent('Usage')
 fireEvent.click(trigger)
 expect(await screen.findByText('Weekly window')).toBeInTheDocument()
 expect(screen.queryByText('Short window')).toBeNull()
})
it('keeps native and shared third-party buckets separate without inventing an account total',async()=>{
 const windows=[
  {id:'gemini-weekly',label:'Gemini weekly',group:'native' as const,utilization:20,resets:null,checked_at:now},
  {id:'3p-weekly',label:'Claude / GPT weekly',group:'third_party' as const,utilization:95,resets:null,checked_at:now},
  {id:'future-model',label:'New allowance',group:'other' as const,utilization:null,resets:null,checked_at:now},
 ]
 const agy={...login('agy',['a'],0),window:null,windows:[],display_windows:windows}
 const grouped=usageAccounts([agy,{...agy,login_key:'second',display_windows:[{...windows[1],utilization:70,checked_at:new Date(Date.parse(now)-1000).toISOString()}]}])
 expect(grouped).toHaveLength(1);expect(grouped[0].windows.size).toBe(3);expect(grouped[0].windows.get('3p-weekly')?.utilization).toBe(95)
 render(<MemoryRouter><ConversationUsage quota={{...quota,logins:[agy]}} selectedAgents={['a']} agents={[]} scope={{}} userId="u" onRefresh={()=>{}}/></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:'Usage: Gemini weekly: 20% used'}))
 expect(await screen.findByText('Gemini weekly')).toBeInTheDocument()
 const third=screen.getByText(/Third-party model allowances/).closest('details')!
 expect(third.open).toBe(false);expect(third).toHaveTextContent('Limit approaching')
 fireEvent.click(third.querySelector('summary')!)
 expect(third).toHaveTextContent('Claude / GPT weekly');expect(third).toHaveTextContent('95% used')
 expect(screen.queryByText('Short window')).toBeNull()
})

afterEach(async()=>{await i18n.changeLanguage('en')})
it('localizes canonical named Claude windows in the new display DTO',async()=>{
 await i18n.changeLanguage('zh-CN')
 const reading={...login('claude',['a'],80),display_windows:[
  {id:'five_hour',label:'Session',group:'account' as const,utilization:80,resets:null,checked_at:now},
  {id:'seven_day',label:'Weekly',group:'account' as const,utilization:40,resets:null,checked_at:now},
 ]}
 render(<MemoryRouter><ConversationUsage quota={{...quota,logins:[reading]}} selectedAgents={['a']} agents={[]} scope={{}} userId="u" onRefresh={()=>{}}/></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:'用量: 已用 80%'}))
 expect(await screen.findByText('短期窗口')).toBeInTheDocument()
 expect(screen.getByText('每周窗口')).toBeInTheDocument()
 expect(screen.queryByText('Session')).toBeNull();expect(screen.queryByText('Weekly')).toBeNull()
})
