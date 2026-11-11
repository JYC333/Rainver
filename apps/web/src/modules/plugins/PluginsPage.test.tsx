import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginsPage from './PluginsPage'
import {pluginsApi} from '../../api/client'
import i18n from '../../i18n'
import { formatDate } from '../../i18n/format'

vi.mock('../../api/client', () => ({
  pluginsApi: {
    list: vi.fn(async () => ({
      items: [{
        descriptor: {
          id: 'diary', name: 'Diary', description: 'Daily notes.', version: '1.0.0', category: 'personal',
          default_enabled: false, scope: 'user', lifecycle_status: 'active', permissions: {},
        },
        effective: {
          plugin_id: 'diary', installed: true, installed_version: '1.0.0', enabled: true, visible: true,
          settings: {}, enabled_at: '2026-07-25T00:00:00.000Z', disabled_at: null,
        },
      }],
    })),
    install: vi.fn(), enable: vi.fn(), disable: vi.fn(),
  },
}))

afterEach(async () => { await i18n.changeLanguage('en') })

describe('Optional modules', () => {
  it('reads in English by default', async () => {
    render(<PluginsPage />)
    expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument()
    expect(screen.getByText('Scope: per account')).toBeInTheDocument()
    expect(screen.getByText(`Enabled ${formatDate('2026-07-25T00:00:00.000Z')}`)).toBeInTheDocument()
  })

  it('reads in Chinese, with the enable date in the Chinese locale', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<PluginsPage />)
    expect(screen.getByRole('heading', { name: '可选模块' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '停用' })).toBeInTheDocument()
    expect(screen.getByText('已安装 v1.0.0')).toBeInTheDocument()
    expect(screen.getByText(`启用于 ${formatDate('2026-07-25T00:00:00.000Z')}`)).toBeInTheDocument()
  })
})


it('keeps operation packages on the explicit offline installation path',async()=>{
 vi.mocked(pluginsApi.list).mockResolvedValueOnce({items:[{descriptor:{id:'probe',name:'Probe',description:'Safe module',version:'1.0.0',category:'system',default_enabled:false,scope:'space',lifecycle_status:'available',permissions:{},operation_api:1},effective:{plugin_id:'probe',installed:false,enabled:false,visible:false,settings:{}}}]} as never)
 render(<PluginsPage/>);expect(await screen.findByText('Installation requires the instance administrator’s offline upgrade.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:/^Install$/})).toBeNull()
})

describe('Disable cleanup on the plugin card', () => {
  const disabledProbe = (cleanup: unknown) => ({items:[{
    descriptor:{id:'probe',name:'Probe',description:'Safe module',version:'1.0.0',category:'system',default_enabled:false,scope:'space',lifecycle_status:'available',permissions:{},operation_api:1},
    effective:{plugin_id:'probe',installed:true,installed_version:'1.0.0',enabled:false,visible:true,settings:{},disabled_at:'2026-11-10T00:00:00.000Z'},
    cleanup,
  }]})
  const attention = {state:'needs_attention',pending:0,attention:1,awaiting_restart:0,last_attempt_at:'2026-11-10T00:05:00.000Z'}
  const restart = {state:'awaiting_restart',pending:0,attention:0,awaiting_restart:1,last_attempt_at:'2026-11-10T00:05:00.000Z'}

  it('shows an unfinished cleanup beside Enable, which waits, and retries it as a new disable round', async () => {
    vi.mocked(pluginsApi.list).mockResolvedValueOnce(disabledProbe(attention) as never).mockResolvedValueOnce(disabledProbe(null) as never)
    vi.mocked(pluginsApi.disable).mockResolvedValueOnce({cleanup_pending:false} as never)
    render(<PluginsPage/>)
    const retry = await screen.findByRole('button',{name:'Retry cleanup'})
    expect(screen.getByRole('status')).toHaveTextContent('Some resources from the last disable could not be released (1).')
    expect(screen.getByRole('button',{name:'Enable'})).toBeDisabled()
    fireEvent.click(retry)
    await waitFor(() => expect(pluginsApi.disable).toHaveBeenCalledWith('probe'))
    await waitFor(() => expect(screen.queryByRole('button',{name:'Retry cleanup'})).toBeNull())
    expect(screen.getByRole('button',{name:'Enable'})).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the obligation visible when the retry round still could not release everything, or failed', async () => {
    vi.mocked(pluginsApi.list).mockResolvedValue(disabledProbe(attention) as never)
    vi.mocked(pluginsApi.disable).mockResolvedValueOnce({cleanup_pending:true} as never).mockRejectedValueOnce(new Error('409'))
    render(<PluginsPage/>)
    fireEvent.click(await screen.findByRole('button',{name:'Retry cleanup'}))
    expect(await screen.findByText('Cleanup is still incomplete; see the status above.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button',{name:'Retry cleanup'}))
    expect(await screen.findByText('Action failed. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button',{name:'Retry cleanup'})).toBeInTheDocument()
    vi.mocked(pluginsApi.list).mockReset()
  })

  it('reads in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    vi.mocked(pluginsApi.list).mockResolvedValueOnce(disabledProbe({state:'pending',pending:2,attention:0,awaiting_restart:0,last_attempt_at:null}) as never)
    render(<PluginsPage/>)
    expect(await screen.findByRole('button',{name:'重试清理'})).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('上次停用的资源仍在释放（剩余 2 项）。')
  })

  it('explains a hold kept by its running service process: no retry, only a status refresh until it recovers', async () => {
    vi.mocked(pluginsApi.list).mockResolvedValueOnce(disabledProbe(restart) as never).mockResolvedValueOnce(disabledProbe(null) as never)
    vi.mocked(pluginsApi.disable).mockClear()
    render(<PluginsPage/>)
    const refresh = await screen.findByRole('button',{name:'Refresh status'})
    expect(screen.getByRole('status')).toHaveTextContent('Retrying cannot release them: they are released automatically after that service process restarts or exits.')
    expect(screen.queryByRole('button',{name:'Retry cleanup'})).toBeNull()
    expect(screen.getByRole('button',{name:'Enable'})).toBeDisabled()
    // The owner process ended and the hold settled: the refreshed card is clean and Enable is available again.
    fireEvent.click(refresh)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.getByRole('button',{name:'Enable'})).toBeEnabled()
    expect(pluginsApi.disable).not.toHaveBeenCalled()
  })

  it('keeps Retry for a failed release next to a hold that waits for its process, and names both', async () => {
    vi.mocked(pluginsApi.list).mockResolvedValueOnce(disabledProbe({...attention,awaiting_restart:2}) as never)
    render(<PluginsPage/>)
    expect(await screen.findByRole('button',{name:'Retry cleanup'})).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:'Refresh status'})).toBeNull()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('could not be released (1)')
    expect(status).toHaveTextContent('2 resource(s) from the last disable are still held by the running service process.')
  })

  it('reads the process-held state in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    vi.mocked(pluginsApi.list).mockResolvedValueOnce(disabledProbe(restart) as never)
    render(<PluginsPage/>)
    expect(await screen.findByRole('button',{name:'刷新状态'})).toBeInTheDocument()
    expect(screen.queryByRole('button',{name:'重试清理'})).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('重试清理无法释放；所属服务进程重启或退出后会自动释放。在此之前无法重新启用。')
  })
})
