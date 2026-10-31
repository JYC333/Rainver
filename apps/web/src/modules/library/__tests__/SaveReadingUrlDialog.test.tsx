import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,it,expect,vi} from 'vitest'
import {SaveReadingUrlDialog} from '../SaveReadingUrlDialog'
import {sourcesApi} from '../../../api/client'
vi.mock('../../../api/client',()=>({sourcesApi:{createManualUrl:vi.fn(),prepareMaterial:vi.fn(),materialProcessing:vi.fn(),cancelMaterialProcessing:vi.fn(),requestMaterialStorage:vi.fn(),getItem:vi.fn()},proposalsApi:{accept:vi.fn()}}))
vi.mock('../../../contexts/SpaceContext',()=>({useSpace:()=>({userId:'u'})}))
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
const api=vi.mocked(sourcesApi)
beforeEach(()=>{vi.clearAllMocks();api.createManualUrl.mockResolvedValue({id:'item',space_id:'s',title:'Saved',content_state:'metadata_only'} as never)})
it('starts preparation before its panel observes it, so a queued Run is never shown as idle',async()=>{
 const order:string[]=[];api.prepareMaterial.mockImplementation(async()=>{order.push('prepare');return {status:'queued',run_id:'r'}});api.materialProcessing.mockImplementation(async()=>{order.push('read');return {status:'queued',run_id:'r'}})
 render(<MemoryRouter><SaveReadingUrlDialog spaceId="s" onClose={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByRole('textbox',{name:'Article URL'}),{target:{value:'https://example.test/a'}});fireEvent.click(screen.getByRole('button',{name:'Save and prepare'}))
 expect(await screen.findByText('Queued')).toBeInTheDocument();expect(order[0]).toBe('prepare');expect(screen.getByRole('link',{name:'Open Reader'})).toBeInTheDocument();expect(screen.getByRole('link',{name:'View all material'})).toBeInTheDocument()
})
it('keeps the saved link and shows why preparation was refused',async()=>{
 api.prepareMaterial.mockRejectedValue(new Error('source_goal_execution_setup_required'));api.materialProcessing.mockResolvedValue({status:'idle'})
 render(<MemoryRouter><SaveReadingUrlDialog spaceId="s" onClose={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByRole('textbox',{name:'Article URL'}),{target:{value:'https://example.test/a'}});fireEvent.click(screen.getByRole('button',{name:'Save and prepare'}))
 await waitFor(()=>expect(screen.getByText('Saved')).toBeInTheDocument());expect(screen.getByRole('alert')).toHaveTextContent('source_goal_execution_setup_required')
})
