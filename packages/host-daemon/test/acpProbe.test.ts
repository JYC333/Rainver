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

  it('recognizes the ACP authentication-required reason and the message-only phrasing', () => {
    expect(isAcpAuthRequiredError({ code: -32000, data: { reason: 'auth_required' } })).toBe(true)
    expect(isAcpAuthRequiredError({ code: -32000, message: 'Authentication required' })).toBe(true)
    expect(isAcpAuthRequiredError({ code: -32000, message: 'workspace failed' })).toBe(false)
    expect(isAcpAuthRequiredError(null)).toBe(false)
  })

  it('reports unauthenticated only for auth_required; another session failure keeps the advertised methods with the login state unknown', () => {
    const methods = parseAcpAuthMethods([{ id: 'browser', name: 'Browser' }])
    expect(parseAcpSessionProbeResult(undefined, { code: -32000, data: { reason: 'auth_required' } }, methods))
      .toMatchObject({ authenticated: false, auth_methods: [expect.objectContaining({ id: 'browser' })] })
    // The methods are the only login path a registry agent has, and not
    // every agent says auth_required when it is not logged in.
    expect(parseAcpSessionProbeResult(undefined, { code: -32000, message: 'workspace failed' }, methods))
      .toEqual({ config_options: [], auth_methods: methods, authenticated: null })
    // With nothing advertised there is nothing to keep: inconclusive.
    expect(parseAcpSessionProbeResult(undefined, { code: -32000, message: 'workspace failed' }, [])).toBeNull()
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

describe('probeAcpOptions failure reporting', () => {
  it('names a copy that exits before answering, with its stderr', async () => {
    const { probeAcpOptions } = await import('../src/acpProbe.js')
    const reasons: string[] = []
    // Pipe writes are asynchronous on macOS and Windows: exit from the write
    // callback, or the message is lost before the parent can read it.
    const result = await probeAcpOptions(process.execPath, ['-e', 'process.stderr.write("boom: not logged in", () => process.exit(3))'], {}, process.cwd(), 5_000, r => reasons.push(r))
    expect(result).toBeNull()
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/exited \(code 3\) before answering; stderr: boom: not logged in/)
  })

  it('names a copy whose command cannot be started', async () => {
    const { probeAcpOptions } = await import('../src/acpProbe.js')
    const reasons: string[] = []
    const result = await probeAcpOptions('/nonexistent/rainver-probe-binary', [], {}, process.cwd(), 5_000, r => reasons.push(r))
    expect(result).toBeNull()
    expect(reasons.join('\n')).toMatch(/cannot start \/nonexistent\/rainver-probe-binary/)
  })

  it('names a session that fails for a reason other than auth_required when no auth method was advertised', async () => {
    const { probeAcpOptions } = await import('../src/acpProbe.js')
    const reasons: string[] = []
    // A fake agent that answers over stdio and then stays alive until the
    // probe kills it, so its asynchronous pipe writes (macOS, Windows) are
    // flushed rather than lost to an early exit.
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      setInterval(() => {}, 1000);
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { authMethods: [] } }) + "\\n");
        if (msg.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "workspace failed" } }) + "\\n");
      });
    `
    const result = await probeAcpOptions(process.execPath, ['-e', script], {}, process.cwd(), 5_000, r => reasons.push(r))
    expect(result).toBeNull()
    expect(reasons[0]).toMatch(/session\/new failed with a reason other than auth_required and initialize advertised no auth method: .*workspace failed/)
  })
})

describe('probeAcpOptions authentication', () => {
  // A fake Cursor: advertises cursor_login, refuses the first session with the
  // message-only phrasing, accepts authenticate when told to, then opens.
  function fakeAgent(acceptsAuthenticate: boolean): string {
    return `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      setInterval(() => {}, 1000);
      let authenticated = false;
      rl.on("line", (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) + "\\n");
        if (msg.method === "initialize") return reply({ result: { authMethods: [{ id: "cursor_login", name: "Cursor Login" }] } });
        if (msg.method === "authenticate") {
          if (${acceptsAuthenticate}) { authenticated = true; return reply({ result: {} }); }
          return reply({ error: { code: -32000, message: "No credentials" } });
        }
        if (msg.method === "session/new") {
          if (!authenticated) return reply({ error: { code: -32000, message: "Authentication required", data: { message: "run 'agent login' first" } } });
          return reply({ result: { sessionId: "s1", configOptions: [] } });
        }
      });
    `
  }

  it('authenticates with the advertised Agent-Auth method and reports a logged-in copy', async () => {
    const { probeAcpOptions } = await import('../src/acpProbe.js')
    const result = await probeAcpOptions(process.execPath, ['-e', fakeAgent(true)], {}, process.cwd(), 10_000)
    expect(result).toMatchObject({ authenticated: true, auth_methods: [expect.objectContaining({ id: 'cursor_login' })] })
  })

  it('reports a copy whose authenticate is refused as not logged in, methods intact', async () => {
    const { probeAcpOptions } = await import('../src/acpProbe.js')
    const result = await probeAcpOptions(process.execPath, ['-e', fakeAgent(false)], {}, process.cwd(), 10_000)
    expect(result).toEqual({ config_options: [], auth_methods: [expect.objectContaining({ id: 'cursor_login' })], authenticated: false })
  })
})
