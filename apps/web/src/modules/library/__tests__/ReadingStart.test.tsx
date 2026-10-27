import {fireEvent,render,screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {it,expect,vi,afterEach,beforeEach} from 'vitest'
import {ReadingStart} from '../ReadingStart'
import i18n from '../../../i18n'
import {informationDigestsApi} from '../../../api/client'
vi.mock('../../../api/client',()=>({informationDigestsApi:{reading:vi.fn()}}))
beforeEach(()=>{vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[],total:0,next_cursor:null})})
vi.mock('../../../core/spaceNav',async()=>({SpaceLink:(await import('react-router-dom')).Link}))
vi.mock('../SaveReadingUrlDialog',()=>({SaveReadingUrlDialog:({onClose}:{onClose:(changed:boolean)=>void})=><div role="dialog"><button onClick={()=>onClose(false)}>Cancel save</button><button onClick={()=>onClose(true)}>Saved article</button></div>}))
afterEach(()=>{void i18n.changeLanguage('en')})
it.each(['en','zh-CN'])('offers a generic goal and direct save without a technical form (%s)',async locale=>{await i18n.changeLanguage(locale);render(<MemoryRouter><ReadingStart spaceId="s" view="pending" onChanged={()=>{}}/></MemoryRouter>);expect(await screen.findByRole('heading',{name:locale==='en'?'What would you like to keep following?':'你想持续关注什么？'})).toBeInTheDocument();expect(screen.getByRole('link',{name:locale==='en'?'Describe your goal':'描述关注目标'})).toHaveAttribute('href','/sources/goals/new');expect(screen.queryByRole('textbox')).not.toBeInTheDocument()})
it('carries Project context and invalidates Reading only after a real save',async()=>{const changed=vi.fn();render(<MemoryRouter><ReadingStart spaceId="s" projectId="p" view="all" onChanged={changed}/></MemoryRouter>);expect(await screen.findByRole('link',{name:'Describe your goal'})).toHaveAttribute('href','/sources/goals/new?project_id=p');fireEvent.click(screen.getByRole('button',{name:'Save an article'}));fireEvent.click(screen.getByRole('button',{name:'Cancel save'}));expect(changed).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Save an article'}));fireEvent.click(screen.getByRole('button',{name:'Saved article'}));expect(changed).toHaveBeenCalledTimes(1)})

it('preserves completed-reading guidance from server counts instead of treating it as a first visit',async()=>{vi.mocked(informationDigestsApi.reading).mockResolvedValue({items:[],total:2,next_cursor:null});render(<MemoryRouter><ReadingStart spaceId="s" view="pending" onChanged={()=>{}}/></MemoryRouter>);expect(await screen.findByRole('heading',{name:'You’re caught up'})).toBeInTheDocument();expect(screen.getByRole('link',{name:'Describe your goal'})).toBeInTheDocument()})
