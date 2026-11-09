import { render, screen } from '@testing-library/react'
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
