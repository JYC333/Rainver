import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PluginsPage from './PluginsPage'
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
