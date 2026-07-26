import { describe, expect, it } from 'vitest'
import { MODULE_REGISTRY, modulesWithEffectivePlugins } from '../modules/registry'

describe('module registry official plugin overlay', () => {
  it('overlays official plugin enabled and visible state from the backend map', () => {
    const modules = modulesWithEffectivePlugins(MODULE_REGISTRY, {
      diary: { enabled: true, visible: false },
    })

    const diary = modules.find(module => module.id === 'diary')
    expect(diary?.enabled).toBe(true)
    expect(diary?.visible).toBe(false)
  })

  it('overlays finance_ledger effective state onto the finance module', () => {
    const staticFinance = MODULE_REGISTRY.find(module => module.id === 'finance')
    expect(staticFinance?.pluginId).toBe('finance_ledger')
    expect(staticFinance?.enabled).toBe(false)

    const modules = modulesWithEffectivePlugins(MODULE_REGISTRY, {
      finance_ledger: { enabled: true, visible: true },
    })
    const finance = modules.find(module => module.id === 'finance')
    expect(finance?.enabled).toBe(true)
    expect(finance?.visible).toBe(true)
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

  it('registers Rooms as a built-in space-scoped module', () => {
    const rooms = MODULE_REGISTRY.find(module => module.id === 'rooms')

    expect(rooms).toMatchObject({
      label: 'Rooms',
      path: '/rooms',
      source: 'built_in',
      group: 'agents',
      perspectiveType: 'space-scoped',
      enabled: true,
      visible: true,
      planned: false,
    })
  })

  it('does not register the retired research atlas top-level route', () => {
    expect(MODULE_REGISTRY.some(module => module.id === 'research_atlas')).toBe(false)
    expect(MODULE_REGISTRY.some(module => module.path === '/atlas')).toBe(false)
  })
})
