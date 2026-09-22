# Product and Boundaries

## What Rainver Is

Rainver is a **server-authoritative Agent Workbench for individuals, households, and
small teams**. It carries substantial daily work—research, writing, knowledge synthesis,
projects, recurring workflows, automation, and code work—through auditable human-agent
collaboration. It captures inputs, runs agents, produces reviewable artifacts and proposals,
and governs what becomes durable memory or action.

Personal, household, and small-team use are first-order contexts from the start; collaboration
is not a later enterprise add-on. Memory and context are foundational substrate for the
workbench, not the complete product identity. Reviewable Evolution workflows are supporting
cast and always execute through an explicitly selected ordinary Agent.

It is not:
- a chat app
- a coding agent wrapper
- a personal notes app
- a task manager
- an app gallery

The core loop is:

```
capture / trigger
→ Activity / Source
→ Agent Run / Job
→ Artifact + Proposal
→ Human Review
→ Memory / Knowledge / Domain Object / Task / Action
```

## Durable Product Boundaries

### Space is the isolation boundary

- `space_id` is required on every core data entity.
- Data in one space must never be accessible from another space's execution context.
- A deployment instance may host multiple spaces (personal, household, team).

### User, Agent, and Actor are separate

- **User** — a human identity with space memberships.
- **Agent** — an AI execution profile with versioned config, model, runtime, and policy. Not the same as a User.
- **Actor** — the general execution/authorship identity: user, agent, system, automation, connector, or service account. New audit and RunStep surfaces carry actor identity.
- Do not merge User and Agent.

### Project is a context container, not a repository

- A Project may contain activities, tasks, runs, artifacts, proposals, memory, and owned Project Folders (files, attached repositories).
- A code repository is an owned Project Folder resource, not the definition of Project. A Project Folder belongs to exactly one Project.

### ModelProvider and RuntimeAdapter are separate

- `ModelProvider` = vendor identity, model catalog, API endpoint, credential pool,
  and Space grant. Managed chat protocol and capability profile are resolved by
  the server vendor registry and executed through pi-ai; which pi-ai catalog
  describes a vendor's models is the adapter's own fact, not the registry's.
  Configurable endpoint and NetworkProfile routing remain Rainver authority.
- Configured per space via `GET/POST/PATCH /api/v1/providers`. API keys are encrypted server-side; responses expose `has_api_key` only.
- `AgentRuntimeProfile` = mutable deployment authority: ACP `runtime_key`, backend mode, execution Host/installation, optional ModelProvider/model, and runtime-specific options.
- `AgentVersion` = immutable Agent behavior and constraint authority; it has no runtime/model fallback.
- One `AcpRuntimeAdapter` implementation dispatches selectable Agent runtimes through the Host daemon. Add a validated ACP runtime definition/spec to `server/src/modules/runtimeAdapters/`; do not add a private Server Agent loop.

### Credential resolution boundary

- Bounded ProviderTask calls resolve credentials through `server/src/modules/providers/`. An ACP `runtime_native` Profile uses the login held by its copy on the execution Host; an eligible `model_provider` Profile uses the short-lived proxy lease (ADR 0008).
- Raw secret values must never appear in adapter config outputs, run steps, artifacts, or logs.
- Direct env-variable credential reads in adapters are not allowed for new work.

### Sandbox and path policy boundary

- The control plane's Project Folder operations use `PgProjectFolderRepository` / `PgRunSandboxManager` and `PathPolicy`; ACP subprocesses access their mounted workspace directly. The built-in strict Host limits that access with a per-Run namespace, while a trusted paired Host runs natively under the owner's OS permissions. **Amended 2026-08-21 ([ADR 0016](../decisions/0016-control-plane-execution-hosts.md)):** the control plane holds no path to a remote Folder and `PathPolicy` is never invoked for that Location; see [SECURITY_AND_ACCESS_BOUNDARIES.md](SECURITY_AND_ACCESS_BOUNDARIES.md) §10.
- Server-host file access for managed/code-patch paths still uses worktree
  helpers. CLI Runs execute on a host daemon (ADR 0016). `one_shot_docker` is
  not a product CLI path; high/critical-risk work that requires it fails closed.
- Server-side adapters must not resolve arbitrary host paths. ACP subprocesses
  access the workspace mounted by their execution Host, under that Host's
  trust-mode boundary.

### Proposal-first for durable change

- Consequential durable changes (memory writes, knowledge writes, code patches, policy changes) go through Proposal → human review → apply.
- Agents do not directly write active memory.
- Agents do not directly write active KnowledgeItem rows. Knowledge writes use `knowledge_*` proposals and accepted proposal apply handlers.
- The public memory write API returns a `ProposalOut` with HTTP 202, not a direct memory mutation.

### Knowledge is not Memory

- Memory is agent context. Knowledge is human-browsable, reviewable, relational long-term content.
- Knowledge items must not automatically enter an accepted Runtime Context Delivery.
- Promoting Knowledge into Memory must be a separate future proposal flow, not an implicit side effect.
- Activity, Run, and Artifact are source inputs for Knowledge proposals.
- Project and Project Folder are contextual associations for Knowledge, not Knowledge content types.
- Knowledge reads use the canonical content-access policy: active members may
  read `space_shared` rows within scope, owners have base access to `private`
  rows, and ordinary `selected_users` readers require an active grant. The sole
  extra read path is eligible owner/admin oversight from the resource Space's
  immutable creation-time mode; it never bypasses scope or grants mutation,
  publication, proposal, or grant-management authority. Sensitivity
  restrictions remain separate deny gates.
- Knowledge relations are database-backed and relation reads omit any row whose endpoints are not both readable by the viewer.

### PolicyEngine evaluates built-in runtime rules; persisted policy enforcement is domain-specific

- `PolicyEngine` evaluates stateless built-in rules. It does not load persisted Policy rows.
- Domain-specific persisted-policy enforcement (e.g. `memory.private_placement`, `run.user_private_scope`) lives in `server/src/modules/policy/`.
- Accepted policy proposals create active `Policy` rows that affect real enforcement decisions.

### App runtime must not self-deploy with arbitrary host authority

- The app container does not directly restart or rebuild itself.
- Product deployment routes create and read `deployment_jobs` for the instance administrator only; no production server path calls the deployer, and the server holds no Docker authority.
- The deployer socket is private to its host-equivalent sidecar and accepts only the three
  core operator job types. Evolution, code-patch, capability, and agent paths cannot reach it.
- The instance is not directly exposed to the public internet.

### External tools are adapters, not product foundations

- Claude Code, Codex, Cursor, LangGraph, OpenAI Agents SDK are runtime adapters.
- Memory, context, policy, proposals, audit, and Project Folder governance live in Rainver's database, not in vendor CLIs.
- OpenCode is a third optional CLI runtime alongside Claude Code and Codex CLI, not a
  universal or preferred execution layer. User-initiated/supervised heavy work may use CLI
  subscription allowance; managed API work keeps its existing direct adapters. Claude
  Pro/Max stays on native Claude Code while OpenCode's provider documentation records that
  Anthropic prohibits using that subscription through OpenCode.

## Current Enforcement Points

| Enforcement point | Current mechanism | Status |
|---|---|---|
| HTTP auth/session identity | Session/API-key identity; no dev-identity fallback | Active |
| Space membership / selected space access | server auth middleware + policy role helpers | Active |
| Memory write (public API) | Returns Proposal (HTTP 202), not direct write | Active |
| Memory proposal apply | Proposal gate + SourceMonitoring gate | Active |
| Memory write boundary | server proposal apply service; no public direct active-memory mutation | Active |
| Knowledge write boundary | `knowledge.*` actions wired via `proposal.apply`; `knowledge_*` handlers in ProposalApplyService | Active |
| Policy proposal apply | Proposal gate creates active Policy row | Active |
| Agent runtime execution | Selected Profile snapshot, execution-Host ACP adapter, Run policy and Host trust boundary | Active |
| Runtime credential use | Credential resolver + secret redaction | Active |
| Project Folder file read | `project_folder.read` route check + `PathPolicy` | Active |
| ACP workspace filesystem access | Direct access to the workspace assigned by the execution Host; strict-host namespace or trusted-host OS permissions, not a per-file Proposal/PathPolicy gate | Active |
| Canonical `code_patch` apply | Approved `code_patch` Proposal gate + `PathPolicy` | Active |
| Project Folder human File-page save | Draft-backed Save to Folder + `project_folder.apply_patch` audit + `PathPolicy` + optimistic draft/Host precondition; history is restore-as-draft only | Active |
| Sandbox path access | Execution Project Folder boundary, worktree root validation | Active |
| Deployment / deployer calls | Instance-admin job records + internal-token pull channel; operator-only deployer socket allowlist | Active |
| Automatic system self-evolution | Removed; Evolution runs require an explicit Agent | Removed |
| Automation fire | Manual and scheduled Automations plus native targets; no external webhook marketplace | Active |
| Connector marketplace | Not present; Sources connections/recipes are the ingestion path | Absent |

## Architecture Fitness Checks

Run these before structural changes:

**Boundary checks:**
- Is Space still the isolation boundary?
- Are User and Agent still separate?
- Is Actor available for authorship/execution identity on new surfaces?
- Is ModelProvider separate from RuntimeAdapter?
- Is Project a context container, not a repo?
- Are vendor instruction files generated artifacts, not source of truth?

**Flow checks:**
- Are durable changes still proposal-first?
- Are raw inputs still Activity-first (not session-first for non-chat)?
- Are memory writes reviewed before apply?
- Can Run explain what happened (via RunStep)?
- Are Jobs separate from Runs?

**Safety checks:**
- Are secrets absent from run output, steps, artifacts, and logs?
- Does an accepted active Policy row change a real enforcement decision?
- Is deployment still manual or allowlisted-deployer-only?
- Does every Evolution run use an explicitly selected ordinary Agent?
- Does Project Folder archive/unregister leave the physical directory untouched rather than hard-delete?
