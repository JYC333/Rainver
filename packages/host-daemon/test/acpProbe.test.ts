import { describe, expect, it } from 'vitest'
import { isAcpAuthRequiredError, parseAcpAuthMethods, parseAcpSessionOptions, parseAcpSessionProbeResult } from '../src/acpProbe.js'

describe('ACP authentication method parsing', () => {
  it('normalizes every protocol auth kind without vendor-specific knowledge', () => {
    expect(parseAcpAuthMethods([
      { id: 'browser', name: 'Browser login', description: 'Open the browser' },
      { id: 'device', name: 'Device code', type: 'terminal', args: ['login', '--device'], env: { AUTH_MODE: 'device', BAD: 1 } },
      { id: 'future', name: 'Future', type: 'unknown' },
    ])).toEqual([
      { id: 'browser', name: 'Browser login', description: 'Open the browser', type: 'agent', args: [], env: {} },
      { id: 'device', name: 'Device code', description: null, type: 'terminal', args: ['login', '--device'], env: { AUTH_MODE: 'device' } },
    ])
  })

  it('recognizes only the explicit ACP authentication-required reason', () => {
    expect(isAcpAuthRequiredError({ code: -32000, data: { reason: 'auth_required' } })).toBe(true)
    expect(isAcpAuthRequiredError({ code: -32000, message: 'workspace failed' })).toBe(false)
    expect(isAcpAuthRequiredError(null)).toBe(false)
  })

  it('reports unauthenticated only for auth_required and treats other session failures as an inconclusive probe', () => {
    const methods = parseAcpAuthMethods([{ id: 'browser', name: 'Browser' }])
    expect(parseAcpSessionProbeResult(undefined, { code: -32000, data: { reason: 'auth_required' } }, methods))
      .toMatchObject({ authenticated: false, auth_methods: [expect.objectContaining({ id: 'browser' })] })
    expect(parseAcpSessionProbeResult(undefined, { code: -32000, message: 'workspace failed' }, methods))
      .toBeNull()
  })
})

describe('ACP session config option parsing', () => {
  it('preserves select groups, unknown categories, and boolean options', () => {
    expect(parseAcpSessionOptions({
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm2',
          options: [{ name: 'Hosted', options: [{ value: 'm2', name: 'Model 2', description: 'Fast' }] }],
        },
        {
          id: 'turbo', name: 'Turbo', category: 'vendor.fast', type: 'boolean', currentValue: true,
        },
      ],
    })).toEqual({ config_options: [
      {
        id: 'model', name: 'Model', description: null, category: 'model', type: 'select', current_value: 'm2',
        options: [{ value: 'm2', name: 'Model 2', description: 'Fast', group: 'Hosted' }],
      },
      {
        id: 'turbo', name: 'Turbo', description: null, category: 'vendor.fast', type: 'boolean', current_value: true,
      },
    ] })
  })

  it('does not project legacy modes into modern config options', () => {
    expect(parseAcpSessionOptions({ modes: { currentModeId: 'ask', availableModes: [] } }))
      .toEqual({ config_options: [] })
  })
})
