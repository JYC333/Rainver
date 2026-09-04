import { describe, expect, it } from 'vitest'
import { hostInstallationOptions, normalizeHostCapabilities } from '../src/modules/hosts/capabilities.js'

describe('host capability normalization', () => {
  it('keeps modern generic ACP options and drops obsolete top-level option maps', () => {
    const current = normalizeHostCapabilities({
      runtimes: ['codex'], versions: { codex: '1.0' },
      installations: { codex_cli: [{
        id: 'own', version: '1.0', logged_in: true,
        options: { config_options: [{
          id: 'fast', name: 'Fast mode', category: 'model_config', description: null,
          type: 'boolean', current_value: true,
        }] },
      }] },
    })
    expect(hostInstallationOptions(current, 'codex_cli', 'own')).toEqual([
      expect.objectContaining({ id: 'fast', type: 'boolean', current_value: true }),
    ])

    expect(normalizeHostCapabilities({
      runtimes: ['codex'], versions: { codex: '1.0' },
      options: { codex: { models: [], current_model: 'old' } },
    }).installations).toEqual({})
  })
})
