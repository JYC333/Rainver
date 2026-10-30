import {render,screen,fireEvent,within,waitFor} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {SourceGoalDeleteButton} from '../SourceGoalDeleteButton'
import {sourceGoalsApi} from '../../../api/client'
vi.mock('../../../api/client',()=>({sourceGoalsApi:{action:vi.fn()}}))
beforeEach(()=>vi.clearAllMocks())
it('requires confirmation and deletes only the selected goal in its Space',async()=>{
 const done=vi.fn();vi.mocked(sourceGoalsApi.action).mockResolvedValue({} as never)
 render(<SourceGoalDeleteButton goalId="goal" spaceId="space" onDeleted={done}/>);
 fireEvent.click(screen.getByRole('button',{name:'Delete goal'}));expect(sourceGoalsApi.action).not.toHaveBeenCalled();const dialog=screen.getByRole('dialog');expect(dialog).toHaveTextContent('Collected reading material will be kept.');fireEvent.click(within(dialog).getByRole('button',{name:'Delete goal'}));await waitFor(()=>expect(done).toHaveBeenCalledOnce());expect(sourceGoalsApi.action).toHaveBeenCalledWith('goal','delete',{}, {spaceId:'space'});
})
it('keeps the goal when deletion fails',async()=>{
 const done=vi.fn();vi.mocked(sourceGoalsApi.action).mockRejectedValue(new Error('denied'))
 render(<SourceGoalDeleteButton goalId="goal" spaceId="space" onDeleted={done}/>);fireEvent.click(screen.getByRole('button',{name:'Delete goal'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'Delete goal'}));expect(await screen.findByRole('alert')).toBeInTheDocument();expect(done).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeInTheDocument();
})
