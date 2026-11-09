import {render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import type {RoomMessage} from '../../types/api'
import {WorkspaceIntegrationNotice} from './WorkspaceIntegrationNotice'
import {ConversationScope} from './ConversationScope'
import {runsApi} from '../../api/client'
import {run} from '../agent_work/fixtures.test-support'
import {workspaceChange} from '../runs/workspaceFixtures.test-support'
import i18n from '../../i18n'

vi.mock('../../api/client',()=>({runsApi:{get:vi.fn(),status:vi.fn()}}))
vi.mock('../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'active',preferredSpaceId:'active'})}))
const facts={schema_version:'workspace_integration_notice.v1',run_id:'origin',integration_id:'integration',attempt_id:'attempt',change_set_id:'change',target_ref:'refs/heads/dev',outcome:'verification_failed',reason:'verification_unconfigured',repair_status:'succeeded',verification_status:'unconfigured',checks_passed:0,checks_failed:0,candidate_ready:true,preserved:true}
function message(details:Record<string,unknown>=facts):RoomMessage{return{id:'notice',space_id:'source',session_id:'session',user_id:null,sender_agent_id:null,role:'system',content:'The isolated change is preserved.',created_at:'2026-11-07T16:28:51Z',metadata_json:{room_display:'system_notice',execution_event:'workspace_integration',execution_event_key:'integration:attempt:verification_failed',execution_details:details}} as RoomMessage}
beforeEach(async()=>{vi.clearAllMocks();await i18n.changeLanguage('en')})
it('explains repair, verification, publication and the concrete next step without fetching or nesting another card',()=>{
 render(<MemoryRouter><ConversationScope spaceId="source"><WorkspaceIntegrationNotice message={message()}/></ConversationScope></MemoryRouter>)
 expect(screen.getByText('Verification incomplete · not integrated into dev')).toBeVisible()
 expect(screen.getByText('The integration Agent Run finished successfully.')).toBeVisible()
 expect(screen.getByText(/No verification checks ran/)).toBeVisible()
 expect(screen.getByText(/Use Let Agent verify and integrate/)).toBeVisible()
 expect(screen.getByRole('link',{name:'Run details'})).toHaveAttribute('href','/spaces/source/runs/origin')
 expect(runsApi.get).not.toHaveBeenCalled()
})
it('enriches an old generic notice from the same authorized attempt and reads its repair separately',async()=>{
 vi.mocked(runsApi.get).mockImplementation(async id=>id==='repair'?run({id:'repair',space_id:'source'}):run({id:'origin',space_id:'source',workspace_changes:[workspaceChange({integration_id:'integration',attempt_id:'attempt',integration_status:'verification_failed',candidate_commit:'c'.repeat(40),resolution_run_id:'repair',integration_detail:{error:'verification_unconfigured'}})]}))
 render(<MemoryRouter><ConversationScope spaceId="source"><WorkspaceIntegrationNotice message={message({run_id:'origin',integration_id:'integration',outcome:'verification_failed'})}/></ConversationScope></MemoryRouter>)
 expect(await screen.findByText(/No verification checks ran/)).toBeVisible()
 expect(await screen.findByText('The integration Agent Run finished successfully.')).toBeVisible()
 expect(runsApi.get).toHaveBeenCalledWith('origin',expect.objectContaining({spaceId:'source'}))
})
it('does not apply a newer attempt to an old notice',async()=>{
 vi.mocked(runsApi.get).mockResolvedValue(run({id:'origin',space_id:'source',workspace_changes:[workspaceChange({integration_id:'integration',attempt_id:'new-attempt',integration_status:'merged'})]}))
 render(<MemoryRouter><ConversationScope spaceId="source"><WorkspaceIntegrationNotice message={message({run_id:'origin',integration_id:'integration'})}/></ConversationScope></MemoryRouter>)
 expect(await screen.findByText(/newer integration attempt exists/)).toBeVisible()
 expect(screen.queryByText('Changes integrated into dev')).not.toBeInTheDocument()
})
it('reports an unavailable legacy read without claiming it succeeded',async()=>{
 vi.mocked(runsApi.get).mockRejectedValue(new Error('permission unavailable'))
 render(<MemoryRouter><WorkspaceIntegrationNotice message={message({run_id:'origin',integration_id:'integration'})}/></MemoryRouter>)
 expect(await screen.findByText(/result could not be read/)).toBeVisible()
 expect(screen.queryByText(/Candidate verification passed/)).not.toBeInTheDocument()
})
it('localizes an actual integration success and keeps its recorded verification count',async()=>{
 await i18n.changeLanguage('zh-CN')
 render(<MemoryRouter><WorkspaceIntegrationNotice message={message({...facts,outcome:'integrated',reason:null,verification_status:'passed',checks_passed:3,preserved:false})}/></MemoryRouter>)
 expect(screen.getByText('修改已合入 dev')).toBeVisible()
 expect(screen.getByText('候选版本验证通过（3 项通过）。')).toBeVisible()
 expect(screen.queryByText(/未合入/)).not.toBeInTheDocument()
 await waitFor(()=>expect(runsApi.get).not.toHaveBeenCalled())
})
