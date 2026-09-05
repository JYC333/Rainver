# Documentation

This is the human-facing index for design and operations docs. The root
[README.md](../README.md) is the project quick start. Coding agents start with
[AGENTS.md](../AGENTS.md) or [CLAUDE.md](../CLAUDE.md), then use
[the development context index](../.agent/INDEX.md) to select relevant guides.
These repository documents are independent of Rainver's product-runtime
context and Skills; an operations guide describes procedures, not runtime prompts.

## Start Here

| Need | Read |
|---|---|
| Product quick start and local development | [../README.md](../README.md) |
| High-level architecture | [../.agent/ARCHITECTURE.md](../.agent/ARCHITECTURE.md) |
| How to run backups, restore, and DB scripts | [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) |
| AI-agent working context | [../.agent/INDEX.md](../.agent/INDEX.md) |

## Architecture

| Document | Description |
|---|---|
| [../.agent/ARCHITECTURE.md](../.agent/ARCHITECTURE.md) | High-level system architecture (layer map) |
| [SPACE_MODEL.md](SPACE_MODEL.md) | Spaces, membership, visibility, and private memory conventions |
| [TARGET_VIEW_MODEL.md](TARGET_VIEW_MODEL.md) | Unified content owner, scope, visibility, and disclosure model |
| [MEMORY_MODEL.md](MEMORY_MODEL.md) | Memory data model and lifecycle |
| [CONTENT_PUBLICATIONS.md](CONTENT_PUBLICATIONS.md) | Targeted immutable publication and import model |
| [TOKEN_USAGE_METERING.md](TOKEN_USAGE_METERING.md) | Token usage attribution, authorization, and dashboard read model |

## Access And Policy

| Document | Description |
|---|---|
| [PERSONAL_MEMORY_GRANT.md](PERSONAL_MEMORY_GRANT.md) | Personal memory grants, egress guard, approval gates |
| [POLICY_AND_PRIVACY_BOUNDARIES.md](POLICY_AND_PRIVACY_BOUNDARIES.md) | Policy enforcement inventory and invariants |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Threat model and sandbox/security assumptions |
| [SANDBOX_POLICY.md](SANDBOX_POLICY.md) | Sandbox execution policy |
| [FEDERATED_ACCESS_MODEL.md](FEDERATED_ACCESS_MODEL.md) | Deferred federated access model |

## Runtime And Agents

| Document | Description |
|---|---|
| [../.agent/architecture/EXECUTION_MODEL.md](../.agent/architecture/EXECUTION_MODEL.md) | Run/agent execution model, agent groups, delegation |
| [CAPABILITY_SYSTEM.md](CAPABILITY_SYSTEM.md) | Capability manifests, registry, enable state, execution |
| [EVOLUTION_CORE.md](EVOLUTION_CORE.md) | Evolution core — source of truth for targets, signals, strategies, runs, experiences |
| [DAILY_CAPTURE_REPORT.md](DAILY_CAPTURE_REPORT.md) | Daily capture/report behavior |

## Operations

| Document | Description |
|---|---|
| [BACKUP_AND_RESTORE.md](BACKUP_AND_RESTORE.md) | Backup, restore, DB dump/restore, verification |
| [TWO_PERSON_DOGFOODING_RC.md](TWO_PERSON_DOGFOODING_RC.md) | Dogfooding release criteria |

## Roadmaps

| Document | Description |
|---|---|
| [FUTURE_ROADMAP.md](FUTURE_ROADMAP.md) | Explicitly deferred work items |
| [MEMORY_CONTEXT_ROADMAP.md](MEMORY_CONTEXT_ROADMAP.md) | Memory context future directions |
| [architecture/evolution-substrate.md](architecture/evolution-substrate.md) | Evolution substrate pointer → see EVOLUTION_CORE.md |
