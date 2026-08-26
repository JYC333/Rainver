# Decision 0004: Vendor Context Files Are Generated Adapters, Not Source of Truth

## Status
Accepted

## Context
Claude Code uses `CLAUDE.md`, Codex uses `AGENTS.md`, Cursor uses `.cursorrules`. Early versions put architecture decisions and user preferences directly in these files. Problems:
- Context locked into a vendor format
- Files could be modified by the CLI agent, corrupting "source of truth"
- No connection between changes in these files and long-term memory
- Token waste: dumping all memory as JSON into the prompt

## Decision
**Vendor-specific files (CLAUDE.md, AGENTS.md, Cursor rules) are generated adapter files, not source of truth.**

The source of truth is:
- `MemoryStore` — long-term scoped context
- `ContextBuilder` — assembles context per space/user/workspace
- `ContextCompiler` — formats it for a specific CLI target

Generated files:
- Are written by `ContextCompiler` to the sandbox directory only
- Are ephemeral — recreated fresh for each run
- Are never written to the real workspace by default
- Are never committed to source control

## Vendor runtime sessions

A vendor CLI may hold a resumable runtime session containing prior conversation turns. This
does not weaken the decision above, and the session is never a source of truth:

- Rainver always retains the ability to replay a full composed context and rebuild the
  conversation from its own `sessions`, context snapshots, and condensed summaries. Resume is
  a capacity optimization, not the authority.
- A backend switch, an invalidated session, or a context that must be re-injected degrades
  back to replay. Resume is never required for correctness.
- Knowledge produced during a resumed conversation reaches Rainver only through tool
  calls that create proposals, or through declared Run Exchange outputs. It is never
  harvested by reading vendor session state.
- Memory writes continue to require proposal approval (ADR 0003). A vendor session holding
  history changes nothing about that path.

## Vendor context files under a read-only Folder mount

When a run mounts the real Project Folder read-only, the vendor context file is materialized
under `SANDBOX_ROOT/read-only-context/<space>/<run>` and mounted over the corresponding
top-level vendor path only inside the runtime's bubblewrap namespace. The real Folder entry
is neither created nor replaced, and the namespace remounts the assembled Folder view
read-only — an OS-level guarantee, not a convention agents are expected to honor.

## Consequences

- `CLAUDE.md` and `AGENTS.md` in the real workspace (if present) are stable, human-authored project docs — not run-specific context
- Run-specific context (memories, preferences, policies, task goal) is always compiled fresh per run
- Changes an agent makes to CLAUDE.md inside its sandbox do not auto-propagate to MemoryStore
- Long-term memory updates still require: agent run → MemoryReflector → `memory_update` proposal → user approval
- ContextCompiler supports targets: `claude`, `codex`, `cursor`, `generic` — extensible for future tools
- Context is concise: only title + content per memory item, capped per scope
