# ADR 0004: Vendor Files And Vendor Sessions Are Never Runtime Authority

Date: 2026-05

## Status

Accepted. Runtime delivery follows [ADR 0014](0014-unified-runtime-context-engine.md)
for server-host execution and [ADR 0016](0016-control-plane-execution-hosts.md)
for remote trusted hosts.

## Context

Vendor formats and resumable CLI sessions may help deliver context, but they
cannot own Rainver's memory, Project state, permissions, or audit history.
Repository development instructions are maintained independently of that
product-runtime delivery system.

## Decision

### 1. Repository guides are development documents

`AGENTS.md`, `CLAUDE.md`, and `.agent/**` guide development of a checkout.
The product server, gateway, adapters, sandboxes, tests, and acceptance gate
must not discover or read them as implicit runtime authority. An explicit
import may create a reviewed product object under ADR 0014; editing a guide
does not change product memory, Project Instructions, or Policy.

Runtime-only vendor control files and Skill layouts follow their owning
adapter and Skill contracts. They are delivery artifacts, not a second source
of truth and not outputs generated from repository development guides.

### 2. Vendor runtime sessions are disposable caches

Resume is an optimization, never the authoritative record. Server-host
continuity is reconstructed through ADR 0014's ledger, checkpoints, and
accepted deliveries; remote host sessions follow ADR 0016. Vendor session
state grants no write authority and is not harvested as canonical memory.
Knowledge enters the product only through governed tool calls or declared
Run Exchange outputs. Memory writes use ADR 0003's canonical applier,
provenance, and conditional approval rules.

## Consequences

- Server-host context delivery uses protocol messages. A vendor requiring a
  different file-based delivery needs an explicit adapter decision; repository
  guides are not a fallback context source.
- Remote Run tool/Skill materialization and its cleanup are scoped by ADR 0016;
  they do not authorize overwriting development guides in the host checkout.
- Development-guide validation may read these files as documentation, never
  as product-runtime input or authority.
