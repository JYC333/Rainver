# ADR 0004: Vendor Files And Vendor Sessions Are Never Source Of Truth

Date: 2026-05 (original)
Rewritten: 2026-08-27 to its remaining scope

## Status

Accepted. The original mechanism (a `ContextCompiler` generating `CLAUDE.md`
/ `AGENTS.md` into the sandbox) was removed by
[ADR 0014](0014-unified-runtime-context-engine.md) decision 12; runtime
context is now delivered as protocol messages. What remains here is the
principle that mechanism served.

## Context

Claude Code reads `CLAUDE.md`, Codex reads `AGENTS.md`, Cursor reads
`.cursorrules`. Early versions put architecture decisions and user
preferences directly in those files, which locked context into vendor formats,
let the CLI agent edit its own "source of truth", and severed the link between
those edits and long-term memory. A later generation generated the files per
run; ADR 0014 replaced generation with protocol delivery. Both changes leave
the same principle standing.

## Decision

### 1. Vendor context files carry no authority

Rainver's authority for model-visible context is the Runtime Context Gateway
(ADR 0014) over memory, Project context, and retrieval. A vendor-format file
is at most a rendering artifact of an accepted delivery; it is never read
back as truth.

`CLAUDE.md`, `AGENTS.md`, `.agent/**`, and similar files that exist in a real
Project Folder or in this repository are human-authored development documents.
The product server, gateway, adapters, sandboxes, tests, and acceptance gate
must not read them as runtime authority, and an agent's edits to them inside a
sandbox never propagate to memory or Project context except through the
ordinary proposal path.

### 2. Vendor runtime sessions are disposable caches

A vendor CLI may hold a resumable session with prior turns. Resume is a
capacity optimisation, never the authority:

- Rainver always retains the ability to rebuild the conversation from its own
  messages, event ledger, checkpoints, and snapshots (ADR 0014 decisions
  10–11). A backend switch, invalidated session, or required context
  re-injection degrades to rebuild; resume is never required for correctness.
- Knowledge produced in a resumed session reaches Rainver only through tool
  calls that create proposals or through declared Run Exchange outputs. It is
  never harvested by reading vendor session state.
- Memory writes still require proposal approval ([ADR 0003](0003-memory-proposal-flow.md)).

## Consequences

- Supporting a future vendor that can only accept a generated file requires
  an explicit adapter decision and conformance boundary; it is not a fallback.
- Run-specific context is always composed fresh per invocation and recorded
  as an Invocation Snapshot; nothing run-specific is written into a real
  Project Folder.

## Revision history

- **2026-05** — accepted with the `ContextCompiler` mechanism.
- **2026-08-10** — mechanism removed by ADR 0014's clean cutover.
- **2026-08-26** — vendor-session and read-only-mount sections added.
- **2026-08-27** — rewritten to the remaining principle. The compiler,
  target list, and per-vendor file table are gone; the read-only-mount
  paragraph is dropped because that staging directory no longer holds a
  vendor file (mechanism in `modules/runtime-adapters.md`).
