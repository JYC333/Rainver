import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,beforeEach} from 'vitest'
import SourceAccessPage from '../SourceAccessPage'
import {sourceGoalsApi} from '../../../api/client'
const state=vi.hoisted(()=>({role:'owner'}))
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({activeSpaceId:'s',spaces:[{id:'s',role:state.role}]})}))
vi.mock('../../../api/client',()=>({sourceGoalsApi:{storeCredential:vi.fn(),message:vi.fn(),begin:vi.fn()}}))
beforeEach(()=>{vi.clearAllMocks();state.role='owner';vi.mocked(sourceGoalsApi.storeCredential).mockResolvedValue({id:'credential',space_id:'s',name:'Fixture access',header_name:'Authorization',header_value_prefix:'Bearer ',created_at:'2026-10-27T00:00:00Z',updated_at:'2026-10-27T00:00:00Z'});sessionStorage.clear();localStorage.clear()})
it('sends the secret only through the dedicated credential channel and clears it after success',async()=>{
 render(<MemoryRouter><SourceAccessPage/></MemoryRouter>);fireEvent.change(screen.getByLabelText('Access name'),{target:{value:'Fixture access'}});fireEvent.change(screen.getByLabelText('Secret'),{target:{value:'fixture-secret-value'}});fireEvent.click(screen.getByRole('button',{name:'Save securely'}));await screen.findByRole('status');expect(sourceGoalsApi.storeCredential).toHaveBeenCalledWith({name:'Fixture access',secret:'fixture-secret-value'},{spaceId:'s'});expect(screen.getByLabelText('Secret')).toHaveValue('');expect(sourceGoalsApi.message).not.toHaveBeenCalled();expect(sourceGoalsApi.begin).not.toHaveBeenCalled();expect(JSON.stringify({...localStorage,...sessionStorage})).not.toContain('fixture-secret-value');
})
it('offers no credential editor to a nonadministrator',()=>{state.role='member';render(<MemoryRouter><SourceAccessPage/></MemoryRouter>);expect(screen.getByRole('alert')).toHaveTextContent('Ask a Space administrator');expect(screen.queryByLabelText('Secret')).not.toBeInTheDocument()})
it('shows a safe error without persisting or echoing the rejected credential',async()=>{vi.mocked(sourceGoalsApi.storeCredential).mockRejectedValue(new Error('fixture-secret-value'));render(<MemoryRouter><SourceAccessPage/></MemoryRouter>);fireEvent.change(screen.getByLabelText('Access name'),{target:{value:'Access'}});fireEvent.change(screen.getByLabelText('Secret'),{target:{value:'fixture-secret-value'}});fireEvent.click(screen.getByRole('button',{name:'Save securely'}));await waitFor(()=>expect(screen.getByRole('alert')).not.toHaveTextContent('fixture-secret-value'));expect(screen.queryByRole('status')).not.toBeInTheDocument()})
