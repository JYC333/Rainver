import { describe, expect, it } from 'vitest'
import { hostInstallationAuthMethods, hostInstallationCliLoginAvailable, hostInstallationOptions, normalizeHostCapabilities } from '../src/modules/hosts/capabilities.js'

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

  it('preserves ACP authentication methods and the separate managed CLI fallback', () => {
    const current = normalizeHostCapabilities({
      runtimes: [], versions: {}, installations: { acp_dynamic: [{
        id: 'managed:1', version: '1', logged_in: false,
        options: {
          config_options: [], session_available: false,
          auth_methods: [
            { id: 'browser', name: 'Browser', description: 'Web flow', type: 'agent', args: [], env: {} },
            { id: 'device', name: 'Device', description: null, type: 'terminal', args: ['login'], env: { MODE: 'device' } },
            // A method that is not `agent` or `terminal` is discarded.
            // Do not treat it as executable.
            { id: 'rainver_cli_login', name: 'CLI login', description: null, type: 'command', args: ['login'], env: {} },
          ],
          cli_login_available: true,
        },
      }] },
    })
    expect(hostInstallationAuthMethods(current, 'acp_dynamic', 'managed:1')).toEqual([
      expect.objectContaining({ id: 'browser', type: 'agent' }),
      expect.objectContaining({ id: 'device', type: 'terminal', args: ['login'], env: { MODE: 'device' } }),
    ])
    expect(hostInstallationCliLoginAvailable(current, 'acp_dynamic', 'managed:1')).toBe(true)
  })

  it('drops or shortens one over-long Agent option instead of refusing the whole report', () => {
    const long = (n: number) => 'x'.repeat(n)
    const current = normalizeHostCapabilities({
      runtimes: [], versions: {}, installations: { acp_dynamic: [{
        id: 'managed:1', version: '1', logged_in: true,
        options: {
          config_options: [
            { id: long(300), name: 'Too long an id', type: 'boolean', current_value: true },
            { id: 'verbose', name: 'Verbose', description: long(5000), category: long(200), type: 'boolean', current_value: false },
          ],
          auth_methods: [
            { id: 'device', name: 'Device', type: 'terminal', args: [long(3000)], env: {} },
            { id: 'browser', name: 'Browser', description: long(5000), type: 'agent', args: [], env: {} },
          ],
        },
      }] },
    })
    expect(hostInstallationOptions(current, 'acp_dynamic', 'managed:1')).toEqual([
      expect.objectContaining({ id: 'verbose', description: long(2000), category: null }),
    ])
    expect(hostInstallationAuthMethods(current, 'acp_dynamic', 'managed:1')).toEqual([
      expect.objectContaining({ id: 'browser', description: long(2000) }),
    ])
  })

  it('drops one over-long held account instead of refusing the whole report', () => {
    const current = normalizeHostCapabilities({
      runtimes: [], versions: {}, installations: { opencode: [{
        id: 'own', version: '1', logged_in: true,
        accounts: [
          { id: 'x'.repeat(300), kind: 'api' },
          { id: 'anthropic', kind: 'k'.repeat(100) },
          { id: 'openai', kind: 'api' },
        ],
      }] },
    })
    expect(current.installations.opencode?.[0]?.accounts).toEqual([{ id: 'openai', kind: 'api' }])
  })
})

it('gates read-only personal Host execution on its normalized capability, never an old or forged mechanism',async()=>{
 const {readOnlyWorkspaceHostRefusal:refuse}=await import('../src/modules/runs/workspaceAccessPolicy.js');
 const supported=normalizeHostCapabilities({workspace_read_only:{supported:true,mechanism:'bwrap-v1',reason:null}});
 expect(refuse('read','codex_cli','remote',supported)).toBeNull();
 expect(refuse('read','codex_cli','remote',normalizeHostCapabilities({}))).toMatch(/bubblewrap/);
 expect(refuse('read','claude_code','remote',normalizeHostCapabilities({workspace_read_only:{supported:true,mechanism:'native-prompt'}}))).toMatch(/bubblewrap/);
 expect(refuse('read','acp_antigravity_acp','remote',{workspace_read_only:{supported:false,mechanism:'bwrap-v1'}})).toMatch(/bubblewrap/);
 expect(refuse('write','codex_cli','remote',{})).toBeNull();
});
