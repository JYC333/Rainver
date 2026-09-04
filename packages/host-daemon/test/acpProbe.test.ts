import { describe, expect, it } from 'vitest'
import { parseAcpSessionOptions } from '../src/acpProbe.js'

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
