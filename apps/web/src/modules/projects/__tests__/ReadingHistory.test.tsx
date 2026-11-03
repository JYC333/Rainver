import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {beforeEach,expect,it,vi} from 'vitest'
import {ReadingHistory} from '../reading/ReadingHistory'
import {projectReadingApi} from '../../../api/client'
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
vi.mock('../../../api/client',()=>({projectReadingApi:{history:vi.fn()}}))
beforeEach(()=>vi.clearAllMocks())
const entry=(kind:string,id:string,date:string|null='2026-01-01')=>({kind,id,date,revision:1,created_at:'2026-01-01T01:00:00Z'})
it('keeps archive discovery visible with an empty overview, fetches on open and pages through every kind of history',async()=>{
 vi.mocked(projectReadingApi.history).mockResolvedValueOnce({items:[entry('edition','day'),entry('theme_analysis','theme')],next_cursor:'next'} as never).mockResolvedValueOnce({items:[entry('edition','older')],next_cursor:null} as never);
 render(<MemoryRouter><ReadingHistory space="s" project="p"/></MemoryRouter>);expect(projectReadingApi.history).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'History & archive'}));
 const links=await screen.findAllByRole('link');expect(links).toHaveLength(2);expect(links[0]).toHaveAttribute('href','/projects/p/sources?tab=overview&date=2026-01-01&composition=day');expect(links[1].getAttribute('href')).toContain('archive=theme&briefing=theme');
 fireEvent.click(screen.getByRole('button',{name:'Older records'}));await waitFor(()=>expect(projectReadingApi.history).toHaveBeenLastCalledWith('s','p','next',expect.anything()));await waitFor(()=>expect(screen.getAllByRole('link')).toHaveLength(1));expect(screen.getByRole('button',{name:'Older records'})).toBeDisabled();
});
it('rechecks authority on pagination and removes previously visible records on denial',async()=>{
 vi.mocked(projectReadingApi.history).mockResolvedValueOnce({items:[entry('edition','private')],next_cursor:'next'} as never).mockRejectedValueOnce(Object.assign(new Error('Archive unavailable'),{status:403}));
 render(<MemoryRouter><ReadingHistory space="s" project="p"/></MemoryRouter>);fireEvent.click(screen.getByRole('button',{name:'History & archive'}));await screen.findByRole('link');fireEvent.click(screen.getByRole('button',{name:'Older records'}));await screen.findByText('Archive unavailable');expect(screen.queryByRole('link')).toBeNull();
});
