# Threat Model

Agent-space manages personal, family, and team data and allows agents to run tools
and generate code. This document enumerates threats and the architectural mitigations
for each.

---

## Threat 1: Cross-space memory leakage

**Scenario**: A user or agent in space A obtains memories from space B.

**Impact**: Privacy violation; exposure of family/team data to unauthorized users.

**Mitigations**:
- `ContextBuilder` raises `ValueError` if called without `space_id`; never queries across spaces.
- `PolicyEngine.rule_space_boundary` denies any action where requesting `space_id` differs from resource `space_id`.
- Every server memory repository query includes `space_id` in its WHERE clause — no global query path exists.
- `content_access_logs` records every cross-person registered-content read for
  after-the-fact auditability; the resource owner can inspect those records.

---

## Threat 2: User memory leakage within a space

**Scenario**: Agent A reads memories belonging to user B in the same space.

**Impact**: User-level privacy breach inside a shared household or team space.

**Mitigations**:
- `Memory.visibility` defaults to `private`; private memories filter to `owner_user_id == user_id`.
- `ContextBuilder` always passes the requesting `user_id`; the memory store enforces visibility.
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
- `CapabilityRegistry.reload()` reads only from `catalog/capabilities/` (not agent-writable at runtime).
- `Capability.status` lifecycle: `draft → proposed → testing → enabled`; agents cannot jump to `enabled`.
- `CapabilityVersion` + `CapabilityTest` require passing tests before promotion.
- `PathPolicy` prevents agents from writing `.py`/`.sh` files directly.

---

## Threat 5: Unsafe tool execution

**Scenario**: An agent invokes a destructive tool (`rm -rf`, `DROP TABLE`, `git push --force`) without authorization.

**Impact**: Data loss; irreversible state changes.

**Mitigations**:
- `Agent.tool_permissions_json` whitelists allowed tools per agent.
- `PolicyEngine.rule_tool_permission` denies any tool not in the whitelist.
- `runtime_policy_json.sandbox_required = true` can mandate sandbox execution.
- All tool calls are logged in `ToolCall` with `status` and `policy_decision_id`.

---

## Threat 6: Secrets / credential leakage to agents

**Scenario**: An agent reads `ANTHROPIC_API_KEY` or SSH keys from the environment or filesystem.

**Impact**: Credential theft; unauthorized external access.

**Mitigations**:
- `PathPolicy` forbids access to `.env`, `.ssh`, `instance/secrets`, `.aws`.
- `Credential.encrypted_secret_ref` — raw secrets are never stored in the DB.
- Agents never receive raw credentials; `ToolRunner` uses them internally and returns only the result.
- `CredentialAccessLog` records every credential use with agent_id and tool_call_id.

---

## Threat 7: Sandbox escape

**Scenario**: An agent running in a sandbox accesses the host filesystem or network outside its declared workspace.

**Impact**: Host compromise; data exfiltration.

**Mitigations**:
- `PathPolicy.validate()` resolves all paths and checks them against the allowed root before any access.
- Sandbox roots come from `settings.sandbox_root` — not agent-controllable.
- `runtime_policy_json.sandbox_required = true` forces isolation for high-risk agents.
- Prefer git worktree sandboxes (copy-on-write) over full repo clones.

---

## Threat 8: Agent self-modification / privilege escalation

**Scenario**: An agent modifies its own `system_prompt`, `runtime_policy_json`, or `memory_policy_json` to escalate its permissions.

**Impact**: Policy bypass; privilege escalation.

**Mitigations**:
- Agent config update requires a human user API call — no agent tool reaches it.
- Agents have no `agent.update` tool in `tool_permissions_json` by default.
- System agents (`owner_type="system"`) can only be modified by admins.

---

## Threat 9: Approval bypass

**Scenario**: A memory or capability proposal is accepted without adequate review, or the approval workflow is skipped entirely.

**Impact**: Incorrect data enters long-term memory; unsafe capability becomes active.

**Mitigations**:
- Proposal acceptance is the only write path to active `Memory` records.
- `Proposal` + `ApprovalEvent` provide a full audit trail (who, what decision, when, comment).
- `required_approver_role` restricts who may approve high-risk proposals.
- `PolicyEngine` returns `REQUIRE_APPROVAL` for protected scope writes; agents cannot bypass this.

---

## Threat 10: Audit log tampering

**Scenario**: A compromised service deletes `content_access_logs`,
`CredentialAccessLog`, or `ApprovalEvent` records to hide actions.

**Impact**: Loss of auditability; forensic gap.

**Mitigations**:
- Log tables are append-only by convention — no soft-delete columns, no update paths.
- Agents have no tool permission to delete log records.
- For production: ship logs to an immutable external sink (S3, CloudWatch, SIEM). *(Deferred — architecture note.)*

---

## Threat 11: PII / secrets in run logs

**Scenario**: Agent prompts or tool outputs contain PII or API keys stored verbatim in `Run.prompt` or `ToolCall.output_json`.

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
- `PathPolicy.validate()` calls `Path.resolve()` then `relative_to(root)` — any traversal attempt raises `PathPolicyError` before the filesystem is touched.
- `_FORBIDDEN_FRAGMENTS` blacklist catches common targets (`.ssh`, `.env`, `credentials`).
- Workspace roots are validated before sandbox creation: they must exist, be directories, and reside under `settings.workspace_root` unless `Workspace.allow_external_root=True` is explicitly set. Cross-space workspace access returns the same `workspace_not_found` error as a missing workspace.

---

## Layered defense summary

| Layer | Mechanism |
|---|---|
| Space isolation | `ContextBuilder` + `PolicyEngine.rule_space_boundary` |
| User isolation | `Memory.visibility` + `owner_user_id` filtering |
| Agent permissions | `tool_permissions_json` + `memory_policy_json` + `PolicyEngine` |
| Write gating | Proposals module + Proposal + approval/apply gate |
| File access | `PathPolicy.validate()` |
| Credential access | `Credential.encrypted_secret_ref` + `CredentialAccessLog` |
| Capability evolution | `draft → proposed → testing → enabled` lifecycle |
| Audit trail | `content_access_logs`, `ContentReadTrace`, `CredentialAccessLog`, `ApprovalEvent`, `ToolCall` |
