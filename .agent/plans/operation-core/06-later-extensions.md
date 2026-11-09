# Plan 6 — Later Extensions

Status: recorded so they are not lost; none is scheduled. Each starts only when
its trigger appears. Depends on [plan 2](02-plugin-operation-platform.md).

| Extension | Trigger | Shape |
|---|---|---|
| Plugin context providers | A plugin needs data in Agent context without a tool call | `ctx.context.register()`: read-only, token-budgeted, provenance and untrusted-data marking; every provider has a matching read operation and passes the same grant, taint and audit checks |
| Plugin Skills | A plugin ships domain procedure | Progressive-disclosure Skill that may reference only the plugin's own operations; grants nothing |
| CLI tool search | Granted tool count makes `rainver list` noisy | `list` shows id + one line, `describe` gives schema, new `search` |
| External MCP entry | An external MCP client becomes a requirement | Adapter over the operation core: `tools/list` filtered by principal, Space, enablement and policy; `tools/call` into the same executor; annotations derived from side-effect class; proposal operations return a handle and approve through a URL; `@modelcontextprotocol/server` v2 (needs Zod 4) |
| MCP connector plugin kind | Someone needs an external tool rather than plugin data | Wrapped as `mcp.<connector_id>.<tool>`; untrusted by default (durable + open-world, approval required); tool definitions hashed and pinned, change requires re-approval; server-side proxy, per-user tokens never in Run environments ([ADR 0008](../../decisions/0008-credential-channel-isolation.md)); results marked untrusted |
| RLS on plugin tables | A non-official or externally contributed plugin, or one cross-Space leak | `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy on `current_setting('rainver.space_id', true)` (GUCs already set by plan 2) |
| Third-party plugins | Wanting outside contributors or a plugin market | Declarative-only plugins, or out-of-process execution with a capability RPC (reuse the Host daemon isolation channel); Remote DOM or sandboxed iframe UI; signing, version pinning, auto-disable on permission growth, remote kill switch |
| phd_detect discovery feed | The PhD plugin is in real use | phd_detect exposes a read-only opportunity feed; Rainver consumes it as a Source or a plugin query feeding the opportunity inbox |
| PhD → research transition | First real offer accepted in the pilot | On offer acceptance, create or re-point a Project to research with supervisors, interests and documents carried over and relevant paper feeds subscribed |
| Out-of-process plugin runtime | A plugin needs dependencies or isolation the host process cannot give | Ports are serializable by plan 2's rule; swap port implementations for RPC stubs |
