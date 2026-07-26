# Module: Commercialization Scope

## Current Target

agent-space is built for **personal and family use first**.

```
Current users:
  - personal (single user)
  - family (small trusted group, 2–10 people)
  - small trusted team (up to ~20 people)

Current deployment:
  - single instance, self-hosted
  - Linux / WSL2 / server (Docker Compose)
  - browser UI (React SPA / PWA)
  - optional mobile thin client (future)
```

Commercial use is a **possible future path**, not a current implementation driver.
Do not build enterprise features before real personal/family need is established.

## What We've Kept Open (Future-Proofing)

These cost almost nothing now and keep commercial paths open later:

| Decision | Why It Matters Later |
|---|---|
| `core/` and `instance/` separated | Core can be open-sourced; instance data stays private |
| `space_id` on every entity | Multi-tenant isolation already enforced at the data layer |
| Agent model separate from User model | Agents can have org-level ownership without a person behind them |
| Runtime adapters are replaceable | Enterprise deployments can swap out Claude/Codex for internal tools |
| Memory + context remain source of truth | Not locked to any vendor's memory/history system |
| Vendor CLI files are compiled artefacts | No vendor file format becomes a lock-in dependency |
| Capabilities are modular (YAML manifests) | Capability marketplace is possible later |
| Proposal/approval gate exists | Compliance-heavy deployments can enforce human approval on all agent writes |
| `space_id + user_id + project_folder_id` pattern | RBAC extensions can be layered on top without model changes |

## What We Have NOT Built (Deliberate Deferral)

Do not implement these until there is real commercial demand:

- Enterprise SaaS multi-tenancy (per-org instance routing, org billing)
- Subscription billing / metered usage
- Complex RBAC / ABAC (role hierarchies beyond owner/admin/member)
- Enterprise admin console (org-level user provisioning, SSO, SCIM)
- Provider marketplace (plugin store for runtime adapters)
- Kubernetes / remote agent runners
- Container pool management (pre-warmed Docker containers)
- Plugin marketplace with install/uninstall flows
- Compliance-heavy audit system (SOC2, HIPAA, GDPR export)
- Full BYO provider enterprise console (UI for configuring every LLM endpoint)

## Commercial Design Rules (for Future Reference)

When commercialization becomes real, the system must satisfy:

1. No vendor CLI is source of truth for memory, policy, permissions, or audit.
2. CLI tools are replaceable execution backends.
3. An enterprise deployment can disable any runtime adapter without breaking core features.
4. Enterprise deployments support BYO API keys and model endpoints.
5. Core modules (Knowledge Base, flashcards, activity records, memory) work without any coding-agent runtime.
6. Runtime use is auditable (Run records are the audit trail).
7. Provider and data policy is configurable per space.
8. Do not assume Claude Code / Codex licenses allow commercial embedding without separate terms.

Rules 1, 2, 5, 6 are already implemented. Rules 3, 4, 7, 8 are documented constraints for future work.

## Feature Priority for Current Users

Build in this order:

1. Activity capture (thoughts, life logs, notes)
2. Memory proposal/review workflow
3. Knowledge Base (structured knowledge)
4. Flashcards / spaced repetition
5. Assistant chat (with memory context)
6. Files & Code (Project Folder file browser)
7. Agent run logs / diff review
8. Simple family/team space support (invite, roles)

Everything else waits until these are solid.
