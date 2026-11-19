// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MODULE_REGISTRY, modulesWithEffectivePlugins } from '../modules/registry'

describe('module registry official plugin overlay', () => {
  it('overlays an operation package entry (Diary) from the backend map; the legacy /diary route is gone', () => {
    expect(MODULE_REGISTRY.find(module => module.id === 'diary')).toBeUndefined()
    const modules = modulesWithEffectivePlugins(MODULE_REGISTRY, {
      diary: { enabled: true, visible: false },
    })
    const diary = modules.find(module => module.id === 'plugin.diary.journal')
    expect(diary).toMatchObject({ path: '/plugins/diary/journal', pluginId: 'diary', perspectiveType: 'personal', enabled: true, visible: false })
  })

  it('serves Finance from its operation package entry; the legacy /finance route is gone', () => {
    expect(MODULE_REGISTRY.find(module => module.id === 'finance')).toBeUndefined()
    const finance = modulesWithEffectivePlugins(MODULE_REGISTRY, { finance_ledger: { enabled: true, visible: true } })
      .find(module => module.id === 'plugin.finance_ledger.ledger')
    expect(finance).toMatchObject({ path: '/plugins/finance_ledger/ledger', pluginId: 'finance_ledger', perspectiveType: 'space-scoped', enabled: true })
  })

  it('leaves built-in modules on their static registration state', () => {
    const original = MODULE_REGISTRY.find(module => module.id === 'today')
    const modules = modulesWithEffectivePlugins(MODULE_REGISTRY, {
      today: { enabled: false, visible: false },
    })
    const today = modules.find(module => module.id === 'today')

    expect(today?.enabled).toBe(original?.enabled)
    expect(today?.visible).toBe(original?.visible)
  })

  it('registers the built-in Graph module as a lazy space-scoped Knowledge route', () => {
    const graph = MODULE_REGISTRY.find(module => module.id === 'graph')

    expect(graph).toMatchObject({
      label: 'Graph',
      path: '/graph',
      source: 'built_in',
      group: 'knowledge',
      perspectiveType: 'space-scoped',
      enabled: true,
      visible: true,
      planned: false,
    })
  })

  it('does not register a space-scoped Rooms index', () => {
    // Rooms are reached through the Project they belong to. Do not register
    // a cross-Project index. It would be a picker in front of the layer
    // ADR 0018 decision 2 makes invisible. `/projects/:projectId/rooms` stays,
    // as one Room's roster surface, routed by the Projects module.
    expect(MODULE_REGISTRY.find(module => module.id === 'rooms')).toBeUndefined()
  })
})
