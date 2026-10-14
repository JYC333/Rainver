import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NetworkProfilesPage from './NetworkProfilesPage'
import i18n from '../../i18n'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One', spaces: [{ id: 'space-1', role: 'owner' }] }),
}))
vi.mock('../../api/client', () => ({
  networkProfilesApi: {
    list: vi.fn(async () => [{
      id: 'profile-1', name: 'Office proxy', mode: 'http_proxy', proxy_url: 'http://127.0.0.1:7890',
      no_proxy: 'localhost', enabled: false,
    }]),
    delete: vi.fn(),
  },
}))

afterEach(async () => { await i18n.changeLanguage('en') })

describe('Network profiles', () => {
  it('reads in English by default', async () => {
    render(<NetworkProfilesPage />)
    expect(await screen.findByText('Office proxy')).toBeInTheDocument()
    expect(screen.getByText('HTTP proxy')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('reads in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    render(<NetworkProfilesPage />)
    expect(screen.getByRole('heading', { name: '网络配置' })).toBeInTheDocument()
    expect(await screen.findByText('HTTP 代理')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('正在查看：Space One')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
  })
})
