# Threat Model

Rainver manages personal, family, and team data and allows agents to run tools
and generate code. This document enumerates threats and the architectural mitigations
for each.

## Authentication and registration threats

**Scenario**: An attacker guesses a password, replays an invitation, or uses a
pending identity to reach product routes.

**Mitigations**:
- Email/password is normalized and validated at the Rainver facade; failures
  are generic and guarded by Better Auth limits plus bounded IP/normalized-email
  progressive throttling.
- The first account is restricted to `INSTANCE_ADMIN_EMAIL`; subsequent
  registration requires an invitation whose token is stored only as a digest.
- Registration intents reserve invitations, bind the pending Better Auth user,
  and complete Space provisioning under one PostgreSQL transaction. Pending and
  disabled users fail identity introspection. Stale reconciliation cannot undo
  a completed transaction.
- Invitation tokens are URL fragments and are cleared before the browser sends
  the first request, keeping them out of URLs, Referer values and request logs.

**Scenario**: OAuth or reset credentials leak through storage, logs, or an
over-permissive security UI.

**Mitigations**:
- Better Auth OAuth state/origin handling is used through explicit routes;
  provider access/refresh/ID tokens are scrubbed before persistence and Google
  profile updates cannot overwrite the Rainver profile.
- Sessions persist only a digest and user-facing session APIs expose safe ids
  and metadata, never raw cookie tokens or stored digests.
- Password-reset identifiers use Better Auth's hashed, single-use verification
  store. Public recovery responses are generic; manual reset links are returned
  only once to an authenticated instance administrator or the sole-admin local
  CLI. A future mail adapter can consume the same delivery boundary.

---

## Threat 1: Cross-space memory leakage

**Scenario**: A user or agent in space A obtains memories from space B.

**Impact**: Privacy violation; exposure of family/team data to unauthorized users.

**Mitigations**:
- The content read gate and the Runtime Context Gateway refuse to resolve content without an explicit `space_id`; neither queries across spaces.
- The `space_boundary` policy rule (`ruleSpaceBoundary`, `server/src/modules/policy/decisionCore.ts`) denies any action where requesting `space_id` differs from resource `space_id`.
- Every server memory repository query includes `space_id` in its WHERE clause — no global query path exists.
- `content_access_logs` records every cross-person registered-content read for
  after-the-fact auditability; the resource owner can inspect those records.

---

## Threat 2: User memory leakage within a space

**Scenario**: Agent A reads memories belonging to user B in the same space.

**Impact**: User-level privacy breach inside a shared household or team space.

**Mitigations**:
- `Memory.visibility` defaults to `private`; private memories filter to `owner_user_id == user_id`.
- Runtime Context acquisition always passes the instructing user as viewer; the content access predicate enforces visibility.
- Agent's `memory_policy_json.readable_scopes` limits which scopes are fetched at all.
- `content_access_logs` records the viewer and, when applicable, the agent and
  Run responsible for every cross-person access.

---

## Threat 3: Prompt injection via memory content

**Scenario**: Malicious content stored in a memory escapes into the agent's prompt and hijacks its instructions.

**Impact**: Agent takes unintended actions; policy bypass; data exfiltration.

**Mitigations**:
- Memory content is injected as data in a structured context package, not as system-prompt instructions.
- System prompt is set only from `Agent.system_prompt` (admin-controlled, not agent-writable).
- All memory writes go through proposal acceptance, requiring user approval before activation.
- Agents have no tool permission to modify their own `system_prompt`.

---

## Threat 4: Malicious capability installation

**Scenario**: An agent generates a capability that executes arbitrary shell code and silently installs it.

**Impact**: Remote code execution; full system compromise.

**Mitigations**:
- New capability code must flow through review-gated workspace changes.
- The read-only `catalog` module reads manifests only from `catalog/capabilities/` (not agent-writable at runtime).
- `capability_versions.status` lifecycle: `draft → proposed → testing → available` (plus `disabled` / `archived`), with enablement in `capability_enablements` through proposal application; agents cannot jump to `available`.
- `CapabilityVersion` + `CapabilityTest` require passing tests before promotion.
- These controls govern Rainver capability installation, not files an ACP
  runtime writes directly. A runtime can create scripts in a read-write
  workspace; the built-in Host's namespace and the paired Host's machine-owner
  trust boundary constrain what those scripts can reach.

---

## Threat 5: Unsafe tool execution

**Scenario**: An agent invokes a destructive tool (`rm -rf`, `DROP TABLE`, `git push --force`) without authorization.

**Impact**: Data loss; irreversible state changes.

**Mitigations**:
- `Agent.tool_permissions_json` whitelists allowed tools per agent.
- The `tool_permission` policy rule (`ruleToolPermission`) denies any tool not in the whitelist.
- Rainver System Actions are authorized against the Run's persisted tool grants
  and the policy `enforce()` decision; prompt text cannot grant a tool.
- System Action authorization covers Rainver's exposed application tools; it
  does not authorize or intercept shell commands the runtime can execute on
  its Host.
- The Run's resolved `required_sandbox_level` is carried to its execution Host.
  Do not treat `runtime_policy_json.sandbox_required` as an active control: it
  is not a supported Profile option.
- Tool calls are recorded as Run events (`tool_call_started` / `tool_call_completed` /
  `tool_call_failed`); System Action results carry their `policy_decision_record_id`.

---

## Threat 6: Secrets / credential leakage to agents

**Scenario**: An agent reads `ANTHROPIC_API_KEY` or SSH keys from the environment or filesystem.

**Impact**: Credential theft; unauthorized external access.

**Mitigations**:
- `PathPolicy` checks Rainver-mediated folder and file operations. It does not
  mediate direct filesystem access by the ACP runtime: a read-write workspace
  can contain `.env` or other credentials that the runtime process can read.
- `credentials.secret_ref` — raw secrets are never stored in the DB.
- For `model_provider` Profiles, the upstream Provider key stays in the Server's
  Provider boundary; the runtime receives a short-lived proxy lease, not that
  key. A runtime's `runtime_native` login is different: its credential state
  lives on the execution Host and is available to that runtime under the Host's
  OS/namespace permissions. The Server Host account is shared by authorized
  Server-Runtime users; a paired Host's native account belongs to its owner.
- Provider spend and proxy use are authorized and recorded by the Provider
  subsystem; do not infer filesystem credential isolation from that audit.

---

## Threat 7: Sandbox escape

**Scenario**: An agent running in a sandbox accesses the host filesystem or network outside its declared workspace.

**Impact**: Host compromise; data exfiltration.

**Mitigations**:
- `validatePath()` (`@rainver/folder-read`) resolves paths for Rainver-mediated operations such
  as bounded folder reads. It does not constrain the ACP child process's own
  filesystem calls.
- The built-in Host's daemon constructs the Run namespace; the paired-Host
  trust boundary is the paired machine itself (ADR 0016).
- Only `read_only` currently narrows a daemon Run's workspace access; higher
  risk-specific CLI containment is not implemented. `worktree` and
  `one_shot_docker` do not currently add a daemon isolation layer. See the
  [deferred register](../.agent/tasks/deferred-register.md) before treating
  these levels as stronger containment.
- Prefer git worktree sandboxes (copy-on-write) over full repo clones.

---

## Threat 8: Agent self-modification / privilege escalation

**Scenario**: An agent modifies its own `system_prompt`, `runtime_policy_json`, or `memory_policy_json` to escalate its permissions.

**Impact**: Policy bypass; privilege escalation.

**Mitigations**:
- Agent config update requires a human user API call — no agent tool reaches it.
- Agents have no `agent.update` tool in `tool_permissions_json` by default.
- System-managed Agents (no `owner_user_id`) can only be changed by a Space owner
  or admin, and the Assistant (`agent_kind = system_assistant`) not through the
  Agent mutation routes at all (`server/src/modules/agents/agentAccess.ts`).

---

## Threat 9: Approval bypass

**Scenario**: A memory or capability proposal is accepted without adequate review, or the approval workflow is skipped entirely.

**Impact**: Incorrect data enters long-term memory; unsafe capability becomes active.

**Mitigations**:
- Proposal acceptance is the only write path to active `Memory` records.
- `proposals` review fields (`status`, `reviewed_by`, `reviewed_at`), `proposal_approvals`
  rows, and `proposal.apply` PolicyDecisionRecords provide the audit trail (who, what decision, when).
- `required_approver_role` restricts who may approve high-risk proposals.
- The policy engine returns `REQUIRE_APPROVAL` for protected scope writes; agents cannot bypass this.

---

## Threat 10: Audit log tampering

**Scenario**: A compromised service deletes `content_access_logs`,
`policy_decision_records`, or `proposal_approvals` records to hide actions.

**Impact**: Loss of auditability; forensic gap.

**Mitigations**:
- Log tables are append-only by convention — no soft-delete columns, no update paths.
- Agents have no tool permission to delete log records.
- For production: ship logs to an immutable external sink (S3, CloudWatch, SIEM). *(Deferred — architecture note.)*

---

## Threat 11: PII / secrets in run logs

**Scenario**: Agent prompts or tool outputs contain PII or API keys stored verbatim in `runs.prompt` or Run event payloads.

**Impact**: PII exposure via log access.

**Mitigations**:
- `PathPolicy` prevents agents from reading `.env` files into prompts.
- For production: apply column-level encryption or redaction before writes. *(Deferred.)*
- Define `cleanup_after_days` per workspace in `instance/config/` for log retention.

---

## Threat 12: Workspace path traversal

**Scenario**: An agent constructs `../../instance/secrets/key.pem` to read files outside its workspace.

**Impact**: Secrets or system file access.

**Mitigations**:
- `validatePath()` (`packages/folder-read/src/pathPolicy.ts`) resolves the path and checks it stays inside the root (`isInside`) — any traversal attempt raises `PathPolicyError` before the filesystem is touched.
- Forbidden lists catch common targets: directory names (`.ssh`, `.aws`, `.gcp`, `.azure`, `credentials`), `instance/secrets` and `config/secrets`, `.git/config`, file names (`.env`, `id_rsa`, `id_ed25519`), `.pem` / `.key` suffixes, and script suffixes on writes.
- Server-managed Folder roots must stay under `WORKSPACE_ROOT` (`workspaceRoot` in `server/src/config.ts`); attaching an existing external directory is available only on a paired trusted Host. Cross-space Folder access returns the same not-found error as a missing Folder.

---

## Layered defense summary

| Layer | Mechanism |
|---|---|
| Space isolation | content read gate + Runtime Context Gateway + `space_boundary` policy rule |
| User isolation | `Memory.visibility` + `owner_user_id` filtering |
| Agent permissions | `tool_permissions_json` + `memory_policy_json` + policy engine rules |
| Write gating | Proposals module + Proposal + approval/apply gate |
| File access | `validatePath()` (`@rainver/folder-read`) |
| Credential access | `credentials.secret_ref` + `CredentialAccessLog` |
| Capability evolution | `draft → proposed → testing → available` lifecycle |
| Audit trail | `content_access_logs`, `ContentReadTrace`, `CredentialAccessLog`, `proposal_approvals`, `policy_decision_records`, Run tool-call events |
