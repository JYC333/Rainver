// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  routeScopeForPath, sceneForPath, spacePath, stripSpacePrefix,
  RAIL_ITEMS, MOBILE_TAB_ITEMS,
} from '../core/navigation'

describe('navigation model', () => {
  it('treats Home/neutral surfaces as user-scoped and /spaces/:id routes as space-scoped', () => {
    expect(routeScopeForPath('/home')).toBe('home')
    expect(routeScopeForPath('/')).toBe('home')
    expect(routeScopeForPath('/settings')).toBe('home')
    expect(routeScopeForPath('/spaces/team-1/activity')).toBe('space')
    expect(routeScopeForPath('/spaces/team-1/knowledge')).toBe('space')
    expect(routeScopeForPath('/spaces/team-1/today')).toBe('space')
  })

  it('puts Home first in the Global Rail and lists no aggregate/PersonalView entry', () => {
    expect(RAIL_ITEMS[0].id).toBe('home')
    const labels = RAIL_ITEMS.map(i => i.label.toLowerCase())
    expect(labels).not.toContain('personal')
    expect(labels).not.toContain('my view')
    expect(labels).not.toContain('personalview')
    expect(labels).toEqual(expect.arrayContaining([
      'home', 'inbox', 'sources', 'review', 'knowledge', 'tasks', 'projects', 'agents', 'evolution', 'instance settings', 'settings',
    ]))
  })

  it('places Evolution after Agents and before Instance Settings without a badge model', () => {
    const ids = RAIL_ITEMS.map(i => i.id)
    expect(ids.indexOf('evolution')).toBe(ids.indexOf('agents') + 1)
    expect(ids.indexOf('instance-settings')).toBe(ids.indexOf('evolution') + 1)
    const evolution = RAIL_ITEMS.find(i => i.id === 'evolution')
    expect(evolution?.label).toBe('Evolution')
    expect(evolution?.to).toBe('/evolution')
    expect(evolution && 'badge' in evolution).toBe(false)
  })

  it('marks Home and Settings as user-scoped rail items and the rest as space-scoped', () => {
    const byId = Object.fromEntries(RAIL_ITEMS.map(i => [i.id, i.scope]))
    expect(byId.home).toBe('home')
    expect(byId.settings).toBe('home')
    expect(byId['instance-settings']).toBe('home')
    expect(byId.evolution).toBe('home')
    expect(byId.inbox).toBe('space')
    expect(byId.source).toBe('space')
    expect(byId.review).toBe('space')
    expect(byId.knowledge).toBe('space')
  })

  it('keeps Token Usage off the primary rail, reachable from Settings for every member', () => {
    const usage = RAIL_ITEMS.find(i => i.id === 'usage')
    const spaceSettings = RAIL_ITEMS.find(i => i.id === 'space-settings')
    expect(usage).toBeUndefined()
    expect(spaceSettings?.activePaths).not.toContain('/usage')
  })

  it('keeps Home as the first mobile tab', () => {
    expect(MOBILE_TAB_ITEMS[0].id).toBe('home')
  })

  it('selects a scene per route, ignoring the /spaces/:id prefix', () => {
    expect(sceneForPath('/spaces/x/activity')?.id).toBe('inbox')
    expect(sceneForPath('/spaces/x/sources')).toBeNull()
    expect(sceneForPath('/spaces/x/proposals')?.id).toBe('review')
    expect(sceneForPath('/spaces/x/projects')).toBeNull()
    expect(sceneForPath('/spaces/x/agents')?.id).toBe('agents')
    expect(sceneForPath('/spaces/x/rooms')?.id).toBe('agents')
    expect(sceneForPath('/spaces/x/sessions')?.id).toBe('agents')
    expect(sceneForPath('/spaces/x/artifacts')?.id).toBe('artifacts')
    // Knowledge intentionally has no scene sidebar — it uses an in-header breadcrumb switcher.
    expect(sceneForPath('/spaces/x/knowledge')).toBeNull()
    expect(sceneForPath('/spaces/x/knowledge/notes')).toBeNull()
    // Home requires no scene sidebar.
    expect(sceneForPath('/home')).toBeNull()
    expect(sceneForPath('/evolution')).toBeNull()
    expect(sceneForPath('/spaces/x/activity')?.id).not.toBe(sceneForPath('/spaces/x/proposals')?.id)
  })

  it('includes Rooms in the Agents scene sidebar', () => {
    const agentsScene = sceneForPath('/spaces/x/rooms')
    expect(agentsScene?.kind).toBe('route')
    if (agentsScene?.kind !== 'route') throw new Error('expected route scene')
    expect(agentsScene.items).toEqual(expect.arrayContaining([
      { label: 'Rooms', to: '/rooms' },
    ]))
  })
})

describe('spacePath / stripSpacePrefix', () => {
  it('prefixes in-space logical paths with the Space, preserving query strings', () => {
    expect(spacePath('team-1', '/proposals')).toBe('/spaces/team-1/proposals')
    expect(spacePath('team-1', '/activity?status=raw')).toBe('/spaces/team-1/activity?status=raw')
    expect(spacePath('team-1', '/agents/abc')).toBe('/spaces/team-1/agents/abc')
    expect(spacePath('team-1', '/plugins')).toBe('/spaces/team-1/plugins')
  })

  it('leaves user-scoped, already-scoped, and missing-space paths untouched', () => {
    expect(spacePath('team-1', '/home')).toBe('/home')
    expect(spacePath('team-1', '/settings')).toBe('/settings')
    expect(spacePath('team-1', '/instance-settings')).toBe('/instance-settings')
    expect(spacePath('team-1', '/cli-profiles')).toBe('/cli-profiles')
    expect(spacePath('team-1', '/evolution')).toBe('/evolution')
    expect(spacePath('team-1', '/spaces/other/today')).toBe('/spaces/other/today')
    expect(spacePath(null, '/proposals')).toBe('/proposals')
  })

  it('strips a leading /spaces/:id for matching', () => {
    expect(stripSpacePrefix('/spaces/x/proposals')).toBe('/proposals')
    expect(stripSpacePrefix('/spaces/x')).toBe('/')
    expect(stripSpacePrefix('/home')).toBe('/home')
  })
})
