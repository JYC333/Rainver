# AgentVersion vs AgentRuntimeProfile — Authority Boundary

Two tables share model/provider/runtime fields. The split is intentional and
must be preserved.

---

## AgentVersion — design-time authority

`agent_versions` captures the *intent* of an agent: what it should think, what
it can do, and what constraints it operates under. Fields it owns:

- `system_prompt` — the base instruction that defines the agent's role
- `model_config_json` — preferred model config (provider, name, max_tokens)
- `model_provider_id`, `model_name` — preferred model (fallback if no profile)
- `context_policy_json` — which context scopes the agent reads
- `memory_policy_json` — which memory scopes are readable/writable
- `capabilities_json` — capability ceiling (what the agent is allowed to use)
- `tool_permissions_json`, `tool_policy_json` — tool allowlist / audit policy
- `output_policy_json` — egress and format constraints
- `schedule_config_json` — scheduling hints for job-triggered runs
- `output_schema_json` — structured output contract

A version is immutable once published (`published_at IS NOT NULL`). Changing any
of these requires a new version row. Versions accumulate; `agents.current_version_id`
points to the active one.

---

## AgentRuntimeProfile — deployment-time authority

`agent_runtime_profiles` captures *how* an agent is deployed in a specific
environment. Fields it owns:

- `adapter_type` — which runtime adapter executes the agent (model_api, claude_code, etc.)
- `model_provider_id`, `model_name` — production override (wins over version defaults)
- `runtime_config_json` — adapter-specific execution parameters (timeouts, sandbox config,
  and an optional `credential_profile_id` default hint for non-conversation CLI runs)
- `runtime_policy_json` — execution-time risk and rate limits (may tighten version ceiling)

The profile does not own a dedicated credential column. A CLI conversation turn
resolves its credential profile from the signed-in user's own selection on the
session's conversation backend binding, never from a space-shared profile —
see [CLI Surfaces](../decisions/0007-multi-cli-mvp.md) and the credential
channel isolation ADR. Non-conversation CLI runs (Task/Plan/Workflow dispatch)
fall back to the profile's `runtime_config_json.credential_profile_id` hint,
then to the active-space default grant for that runtime.

Profiles are mutable and may be changed without creating a new version. An agent
may have multiple profiles (e.g. dev vs prod) controlled by `enabled` and
`is_default`.

Project Research uses this same authority boundary without requiring manual
Agent setup. Its execution-profile service provisions or reuses a space-scoped
`system_research` Agent and a `model_api` runtime profile from the selected
ModelProvider/model. Research setup does not accept explicit Agent/profile,
runtime-adapter, or CLI-credential selection. The resolved Agent/profile IDs
are recorded in the research workflow and operation before any stage run is
queued.

OpenCode is a local CLI adapter with two credential paths: CLI login state, or
an OpenAI-compatible ModelProvider. In provider mode, the CLI receives a
run-scoped `opencode.json` containing the provider proxy URL and lease token;
the upstream provider key remains inside the server/provider proxy boundary.

---

## Resolution order at run time

`AGENT_COLUMNS` in `agents/repository.ts` resolves using COALESCE priority:

```
adapter_type     → runtime profile > version runtime_policy_json.default_adapter_type
model_provider_id → runtime profile > version
model_name       → runtime profile > version
runtime_policy_json → runtime profile > version
```

The version values are the design-time ceiling; the profile values are the
deployment-time override.

---

## Run snapshot

`runs` stores:
- `agent_version_id` — which version was in effect (immutable, for audit)
- `runtime_profile_id` — which profile was selected (nullable)
- `runtime_profile_snapshot_json` — a point-in-time copy of the profile at run
  start, so profile edits after the fact do not retroactively change run history

The snapshot is authoritative for interpreting a historical run. The live tables
are authoritative for future runs.

---

## What does NOT belong in each

| Field | Belongs in version? | Belongs in profile? |
|---|---|---|
| system_prompt | ✓ | ✗ |
| context/memory policy | ✓ | ✗ |
| capability ceiling | ✓ | ✗ |
| credential to use | ✗ | ✓ |
| adapter type | ✗ (hint only) | ✓ |
| sandbox config | ✗ | ✓ |
| model override for prod | ✗ | ✓ |

If a field determines *what the agent is*, it belongs in `agent_versions`.
If a field determines *how the agent runs in a given environment*, it belongs in
`agent_runtime_profiles`.
