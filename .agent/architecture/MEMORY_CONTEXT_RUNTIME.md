# Memory / Context Runtime

> Source of truth for: MemoryEntry lifecycle, retrieval pipeline, context
> assembly, ContextSnapshot population, ContextDigest cache, proposal apply write
> boundary, session summaries, budget enforcement, and read/policy enforcement
> points.

---

## 1. Core data model

### MemoryEntry

Persistent, approved, scoped knowledge. Key invariants:

| Invariant | Enforcement |
|-----------|-------------|
| `status="active"` only through approved write paths | server proposal apply service; no public direct active-memory mutation |
| Scoped to one space | `space_id` FK; server memory/context repositories enforce hard boundary |
| Private memory only in personal space | Policy hard invariant + memory proposal/apply validation |
| Deleted rows invisible | `deleted_at IS NULL` filter in every retrieval query |

Key columns: `scope_type` (user / project_folder / agent / system / capability),
`memory_type` (public category), `memory_layer` (semantic / episodic),
`visibility`, `status` (proposed / active / archived / superseded),
`version`, `fitness_score`, and `created_from_proposal_id`.

### Active memory write boundary

Public API calls never write active memory directly. Active memory mutation goes
through proposal review and the server proposal apply service. There is no public
direct update/delete path for `memory_entries`.

**Allowed active-memory write paths:**

| Path | Entry point | created_from_proposal_id | source_trust | Notes |
|------|------------|-------------------|--------------|-------|
| Proposal apply | `server/src/modules/proposals/applyService.ts` + memory applier | set | from proposal payload | Normal product write boundary |
| System seed / bootstrap | server seed/migration code | not set | `"internal_system"` | Bootstrap only; must not be called from product or agent paths |

There is no product direct-write memory path. The memory write boundary is structural and is not configurable through persisted Policy rows.

No route, run, condenser, retriever, context builder, activity processor, or agent output path may create active `MemoryEntry` directly.

---

## 2. Read authorization (`server/src/modules/access/contentAccess*.ts`)

```
can_read_memory(entry, user_id, space_id, project_folder_id, include_system_scope) -> bool
```

Hard filter applied before any ranking:
- `space_id` match (never cross-space without PersonalMemoryGrant)
- `deleted_at IS NULL`
- `status == "active"`
- Canonical content gate (active Space membership, scope, owner, visibility,
  and `content_access_grants`)
- Agent permission gate (agent_memory_policy.readable_scopes)

`summary_only_redact_content(entry, viewer_user_id)` — returns True if the viewer may only see summary (PersonalMemoryGrant summary-only mode).

---

## 3. Memory retrieval (`server/src/modules/context/repository.ts`)

Policy-aware retrieval pipeline. The server runtime path implements this in
`server/src/modules/context/repository.ts`.

```
MemoryRetriever(db).retrieve(
    space_id, user_id, project_folder_id, agent_id,
    query, agent_memory_policy, max_memories, include_system_scope
) -> RetrievalResult
```

Stages (in order, each filters the already-hard-filtered universe):
1. **Hard filter** — space, deleted_at, status=active, visibility, agent permission
2. **Symbol match** — project_folder-scoped, agent-scoped, user identity memories
3. **Graph expansion** — BFS on MemoryRelation, max 2 hops, bounded by space
4. **Keyword fallback** — ILIKE on title/content
5. **Embedding fallback** — stub (delegates to keyword)
6. **Final ranking + truncation** — fitness_score, recency, access_count

Returns `RetrievalResult(memories, active_policies, source_refs, retrieval_trace, token_budget)`.

### Memory read providers

Memory read providers are **read-only** (`get`, `list`, `search`). There are no
write methods (`create`, `update`, `delete`) on the read surface. All
active-memory mutations go through proposal approval and the server proposal apply
boundary.

---

## 4. Context assembly (`server/src/modules/context/prepareService.ts` and `repository.ts`)

Security boundary: `space_id` and `user_id` are required. No cross-space reads.

```
ContextBuilder(db).build(
    space_id, user_id,
    project_folder_id?, task_type?, capability_id?, session_id?,
    query?, agent_memory_policy?, agent_id?, run_id?,
    context_reason?, attachments?, project_folder_path?
) -> ContextPackage
```

Responsibilities:
1. Delegates retrieval to `MemoryRetriever`
2. Records `memory_access_logs` (access_type=context_injection) for every injected memory
3. Resolves context attachments (file, file_range, git_diff, staged_diff, folder_tree, recent_commits)
4. Security-scans attachments via `scan_attachment()` / `scan_content()`
5. Loads latest `SessionSummary` for the session when `session_id` is provided
   through the sessions-owned read
   (`PgSessionRepository.getLatestSummaryForContext(...)`), consuming only the
   `SessionSummaryForContext` DTO boundary
6. Partitions memories into sections: user_memory, project_folder_memory, capability_memory, agent_memory, system_policy, relevant_episodes
7. Produces `ContextPackage` with stable_prefix_refs / dynamic_tail_refs split

`recent_session_summary` is populated from `SessionSummary` rows (derived context, **not** MemoryEntry).

### Session summary source traceability

When a `SessionSummary` is loaded, `ContextBuilder` records:

- A `source_ref` entry appended to **both** `source_refs` and `dynamic_tail_refs`:
  ```json
  {
    "source_type": "session_summary",
    "source_id": "<summary.id>",
    "session_id": "<session_id>",
    "version": <summary.version>,
    "section": "dynamic_tail",
    "derived_context": true
  }
  ```
- A `retrieval_trace["session_summary"]` entry:
  ```json
  {
    "session_summary_used": true,
    "session_summary_id": "<summary.id>",
    "session_summary_version": <version>,
    "session_summary_fallback_reason": null
  }
  ```
  If lookup fails or no active summary exists, `session_summary_used=false` and `session_summary_fallback_reason` is set.

---

## 4a. Conversation context (`server/src/modules/agents/chatContextBuilder.ts`)

The existing `ContextBuilder` (§4 above) handles the CLI agent path: it produces a `ContextPackage`
rendered by `ContextCompiler` into an instruction file.  The chat context path is different:

- Input is a `ContextRequest` (not `ContextBuildRequest`)
- Output is a `ContextBundle` (not `ContextPackage`) — a flat list of `ContextBundleItem` records
- Each item carries `item_type`, `item_id`, `title`, `excerpt`, `score`, `reason`, `token_count`
- The bundle is intended to be injected directly into a model call (no instruction-file rendering)
- Result is persisted as `ContextSnapshot` + `ContextSnapshotItem` rows for full auditability

### Context boundary: AgentVersion.context_policy_json

`ChatContextBuilder` reads `AgentVersion.context_policy_json` to determine which source types
are allowed for a given request. **AgentVersion is never mutated** — all per-run selection
decisions are local to `build()` and stored only in `ContextBundle` / `ContextSnapshot`.

`context_policy_json` structure:

```json
{
  "sources": ["memory", "knowledge_item", "project_folder", "activity_record"],
  "max_tokens": 4000,
  "max_items": 20,
  "condenser": {
    "profile": "coding",
    "custom_system": "Optional per-agent condenser system prompt override",
    "custom_instructions": "Optional per-agent condenser user instructions override"
  }
}
```

- `sources` — allowed source types; absent / empty → all types allowed (permissive default)
- `max_tokens` — overrides the per-request budget when set
- `max_items` — overrides the per-request item cap when set
- `condenser.profile` — scenario profile for the `llm.v1` session condenser
  (`adaptive` default / `general` / `coding` / `project`); read by the
  `session_condense` job, unknown / absent → `adaptive` (see §5)
- `condenser.custom_system` / `condenser.custom_instructions` — optional
  per-agent overrides for the selected profile's condenser prompt; blank/absent
  values use the built-in profile prompt. Shared factuality and same-language
  guardrails are always appended server-side.
- Built-in condenser profile prompts are registered as Prompt Library assets
  (`session.condenser.<profile>`). The frontend links to those assets instead
  of duplicating preset prompt text or reading a sessions-owned prompt route.

Supported `item_type` values in a `ContextBundle` / `ContextSnapshotItem`:

| item_type | Source table |
|-----------|-------------|
| `memory` | `memory_entries` (via `MemoryRetriever`) |
| `knowledge_item` | `knowledge_items` (item_type ≠ idea) |
| `idea` | `knowledge_items` (item_type = idea) |
| `source` | `sources` (status = processed) |
| `activity_record` | `activity_records` (recent-first) |
| `project_folder` | `project_folders` (current Project Folder metadata) |
| `project` | `projects` (current project metadata) |
| `manual_context` | Caller-supplied explicit context (highest priority) |
| `task`, `run`, `proposal`, `artifact` | Reserved; not yet selected automatically |

### Selection priority

```
1. manual_context       (score=1.0, always first)
2. project_folder metadata (score=0.9, current Project Folder only)
3. project metadata     (score=0.9, current project only)
4. approved memory      (score=0.8, via server memory/context repositories)
5. knowledge_item/idea  (score=0.7, recent-first + keyword filter)
6. source               (score=0.6, processed, recent-first)
7. activity_record      (score=0.5, recent-first)
```

Deduplication by `(item_type, item_id)` is applied across all sources. Token budget and
max_items caps stop collection once either limit is reached (`truncated=True`).

### API

```ts
const collector = new ChatContextCandidateCollector(repo);
const candidates = await collector.fetchCandidates(request);
const bundle = buildChatContext(candidates);
const conversationWindow = buildChatConversationWindow({
  messages: recentSessionMessages,
  currentMessage,
  summary: latestSessionSummary,
});

await contextSnapshotRepository.persistChatSnapshot({
  contextSnapshotId,
  spaceId,
  tokenEstimate: bundle.token_count + conversationWindow.token_count,
  requestJson: { ...request, conversation_window: conversationWindow.trace },
  retrievalTraceJson: {
    chat_context: bundle.retrieval_trace,
    conversation_window: conversationWindow.trace,
  },
  tokenBudgetJson: {
    chat_context: { token_count: bundle.token_count },
    conversation_window: conversationWindow.trace,
  },
  items: bundle.items,
});
```

Snapshot persistence owns its SQL statement boundaries; callers own larger
workflow orchestration.

### Conversation window projection

The direct agent conversation route projects session history into each queued run
before execution:

1. The current user message is appended to `messages`.
2. The route loads the latest active `SessionSummary` and a bounded recent
   message slice (`listRecentMessagesForContext`, currently 80 newest rows,
   returned chronological).
3. `buildChatConversationWindow()` renders a deterministic window:
   - active summary first, capped to 1200 approximate tokens;
   - recent turns after the summary's `source_last_message_id`;
   - when a summary is present, **all** turns after the watermark are candidates
     (bounded only by the token budget), so a lagging condenser watermark never
     leaves a gap between the summary and the raw tail; the `maxRecentMessages`
     cap (12) applies only when there is no summary, to bound an unsummarized
     history;
   - current user message always as the final turn.
4. Window budget is 6000 approximate tokens. If it overflows, the builder first
   drops messages already covered by summary, then applies the recent-message
   cap (no-summary case only), then compacts/drops older raw turns while
   preserving the current user message.
5. Managed API runtimes (`model_api`, `ts_agent_host`) receive the conversation
   window as native `messages[]` through the runtime-host contract. CLI
   runtimes continue to use the rendered prompt fallback, because vendor CLI
   adapters still execute through instruction files plus a single prompt.
   The structure is persisted in `ContextSnapshot.request_json`,
   `retrieval_trace_json`, and `token_budget_json`.

Room conversations use the same durable `sessions` / `messages` authority but
add multi-party cursor semantics. A local CLI binding is keyed by
user × session × agent. Its first Room turn receives bounded chronological
history. After a successful turn the binding records the triggering Room
message as its cursor; a resumed turn receives messages after that cursor,
including other humans and agents but excluding the recipient agent's own
already-known output. If the cursor is absent from the bounded window, or the
backend/context fingerprint changes, the run starts a new vendor session from
the replay prompt. The vendor session remains a cache, never context authority.

The CLI fallback prompt shape is:

```text
[Conversation window - use this for continuity. Recent turns override older summaries.]

[Condensed earlier conversation]
...

[Recent session turns]
assistant:
...

[Current user message]
user:
...

[Context from your space ...]
```

The managed API message shape is:

```json
[
  {
    "role": "user",
    "content": "[Condensed earlier conversation]\n..."
  },
  {
    "role": "assistant",
    "content": "..."
  },
  {
    "role": "user",
    "content": "<current user message>"
  }
]
```

The selected chat context preamble is appended to the managed API
`system_prompt`, while the fallback `runs.prompt` still contains the fully
rendered prompt for audit and CLI compatibility. In that fallback prompt the
conversation window is the stable prefix and the per-turn retrieved context is
the dynamic tail, so local CLI prompt caches are not invalidated at the first
token by changing retrieval results.

`conversationWindowToMessages` normalizes the native `messages[]` for managed
chat providers (e.g. Anthropic Messages): empty turns are dropped, leading
non-`user` turns are dropped so the list is user-led (reachable when there is no
summary and the budget loop drops the oldest user turn), consecutive same-role
turns are merged so roles alternate, and roles collapse to `user`/`assistant`
only. The list always contains at least one `user` turn.

### ContextSnapshot additions

`context_snapshots` now carries three new nullable columns:
- `agent_id` — FK to `agents.id` (derived from `AgentVersion.agent_id` by the builder)
- `session_id` — FK to `sessions.id` (from `ContextRequest.session_id`)
- `run_id` — FK to `runs.id` (from `ContextRequest.run_id`; avoids circular FK via ALTER TABLE)
- `request_json` — serialised `ContextRequest` for full audit reproducibility
- `retrieval_trace_json` / `token_budget_json` — chat context and
  conversation-window traces, including overflow recovery decisions.

All three FKs use `use_alter=True` because `context_snapshots` is created before the
referenced tables in the baseline migration.

### Not implemented (future scope)

- Embeddings / vector search (no numpy, faiss, pgvector)
- Graph traversal beyond what MemoryRetriever already provides
- Source chunking pipeline
- Full Project Folder file search
- Frontend context picker UI
- Tool-call message preservation in conversation windows. Governed Chat tools
  execute through the normal Run tool gateway, but tool-result turns are not
  yet projected back into the conversation window.

---

## 5. SessionSummary and Session Condensing

Context assembly consumes the context-safe `SessionSummaryForContext` DTO from
the sessions module. Condense/create writes are owned by the sessions module
(`PgSessionRepository.condenseSession`, which owns session internals). The Chat
worker finalizer **enqueues a background `session_condense` job** after it
durably persists a successful assistant message (it does not condense inline or
on the HTTP request path). The job payload carries `source_run_id`, and a
database unique index makes that Run-scoped enqueue idempotent across worker
retries and concurrent reconcilers. Context code still consumes only the DTO
boundary and never writes summaries itself.

### Design invariants

- `SessionSummary` is **derived context**, not active memory. It is never a `MemoryEntry`.
- `condenseSession()` **never** creates a `Proposal` or `MemoryEntry`; it writes only `session_summaries` rows.
- Multiple summaries per session are versioned; old ones become `status="superseded"`.
- `version` is unique per session (`uq_session_summaries_session_version` constraint).
- **At most one active summary per session** — enforced by partial unique index `ix_session_summaries_one_active_per_session` on `(session_id) WHERE status = 'active'`.

### SessionSummary (`session_summaries`)

| Column | Purpose |
|--------|---------|
| `session_id` | FK to Session |
| `space_id` | Scope boundary |
| `user_id` | Who was in the session |
| `version` | Monotonic per session; unique per (session_id, version) |
| `status` | `active` or `superseded` |
| `summary_text` | Condensed plaintext |
| `source_message_count` | How many messages were condensed |
| `source_first_message_id` | First message id in the condensed range |
| `source_last_message_id` | Last message id — watermark for incremental condensing |
| `summary_json` | Structured metadata: role_counts, top_keywords, source_range, condenser_version |
| `token_estimate_before` | Approximate token count of source messages (chars ÷ 4) |
| `token_estimate_after` | Approximate token count of summary_text (chars ÷ 4) |
| `condenser_version` | `pattern.v1` (deterministic) or `llm.v1` (LLM-generated) |

**Indexes:** `(session_id, status)`, `(space_id, session_id, status)`, partial unique `(session_id) WHERE status = 'active'`.

### Session condenser

```
PgSessionRepository.condenseSession(space_id, user_id, session_id, options?) -> SessionSummaryForContext | null
PgSessionRepository.getLatestSummaryForContext(space_id, session_id) -> SessionSummaryForContext | null
```

- Deterministic summary builders live in `server/src/modules/sessions/condenser.ts`
  (`buildPatternSummary`, `buildLlmSummary`). LLM condenser prompts resolve
  through `server/src/modules/sessions/promptRegistry.ts` and the centralized
  Prompt Library assets; the repository owns the DB read/write and fallback
  chain around them.
- Queries messages filtered by **both** `session_id` and `space_id`, non-empty
  content (`content ~ '\S'`), chronological.
- Summarizes every message older than the recent raw tail
  (`keepRecent`, default 12). It is a **no-op** (returns the current active
  summary or `null`) when nothing has aged out, or when fewer than
  `condenseBatch` (default 8) new messages have aged past the last summary's
  cover-range — this bounds version churn so a long chat does not mint a summary
  every turn.
- **Two condenser versions, with a fallback chain** (`condenseSession` picks per
  call):
  - `llm.v1` — when an LLM summarizer is supplied (the `session_condense` job
    supplies one via the `session_condense` provider task). The condenser prompt
    registry selects a **scenario profile** (`adaptive` default / `general` /
    `coding` / `project`) from `AgentVersion.context_policy_json.condenser.profile`
    and resolves `session.condenser.<profile>` through the Prompt Library,
    feeding the prior summary plus only the newly aged-out turns (incremental, to
    bound token cost). The model writes a real running summary.
  - `pattern.v1` — deterministic fallback (role counts + keyword + highlight
    digest, no model call). Used when no summarizer is supplied, no provider is
    configured for the `session_condense` task, or the LLM call fails / returns
    empty. The condenser therefore **never hard-fails for lack of a provider**.
- Writes a new active version and supersedes the prior active row
  (supersede-then-insert keeps at most one active row at every moment, so the
  partial unique active index holds without an explicit transaction). The new
  `version` exceeds every existing version (active or superseded), so an orphan
  row left by an interrupted condense cannot collide.
- Fills all source range fields (`source_first_message_id`,
  `source_last_message_id`, `source_message_count` — always the full covered
  range, even when only the delta was fed to the LLM), populates `summary_json`
  with structured metadata, and estimates `token_estimate_before` /
  `token_estimate_after` (chars ÷ 4).
- Concurrency for the same session is out of scope (P2). A racing writer fails
  closed via the version unique constraint / partial unique active index rather
  than creating a second active summary; the chat route treats the condense
  **enqueue** failure as non-fatal (the user already has their reply), and the
  job runner retries the job itself.
- The first summary appears once a session reaches `keepRecent + condenseBatch`
  (default 20) non-empty messages. Before that the conversation window keeps the
  last `maxRecentMessages` (12) raw turns and drops older ones via the recent cap
  (recorded as `messages_dropped_for_recent_limit` in the window trace) — this is
  the bounded-window design, not a silent loss. Once a summary exists, the window
  shows **all** turns after its watermark (budget-bounded), so there is no gap
  between the summary and the raw tail even while the watermark lags by a batch.
- The `pattern.v1` path re-summarizes the full older range from scratch (cost is
  O(n) in session length, run at most once per `condenseBatch` messages),
  acceptable at personal-assistant scale. The `llm.v1` path is incremental: it
  feeds only the prior summary plus the newly aged-out turns, so its per-condense
  input stays bounded.

---

## 6. ContextCompiler (`server/src/modules/context/compiler.ts`)

Translates `ContextPackage` → CLI instruction file (CLAUDE.md / AGENTS.md / etc.) in the sandbox directory.

### Section priority and budget enforcement

Sections ordered by priority (lower = more important = last to drop). The
prepared run path uses `stable_prefix` / `dynamic_tail`; the older raw
`ContextPackage` path uses the per-scope sections below.

| Priority | Section | Mandatory | Per-section cap |
|----------|---------|-----------|----------------|
| 0 | task | **yes** | none |
| 1 | stable_prefix | no | — |
| 1 | system_policy | no | 16 000 chars |
| 1 | policy | no | — |
| 2 | user_context | no | 8 000 chars |
| 3 | project_docs | no | 24 000 chars |
| 4 | project_folder | no | 12 000 chars |
| 5 | capability | no | — |
| 6 | agent | no | 8 000 chars |
| 7 | attachments | no | 16 000 chars |
| 8 | episodes | no | 4 000 chars |
| 8 | dynamic_tail | no | — |
| 9 | session | no | 2 000 chars |
| 10 | tools | no | — |
| 11 | sandbox | no | — |
| 12 | validation | no | — |
| 13 | constraints | no | — |
| 14 | output_format | no | — |

**Mandatory sections** are never dropped even when the total budget is exceeded.

**Per-section caps** truncate oversized sections before they enter the budget loop (with a `[truncated]` trailer). Truncation is recorded in `budget_trace`.

**`budget_trace`** (returned in `CompiledContext`): records mandatory sections,
capped sections (with original/capped sizes), compacted sections, and dropped
sections.

### ContextCompiler.budget_trace vs ContextSnapshot token_budget_json

These are **distinct** — do not conflate them:

| Field | Source | Contents |
|-------|--------|---------|
| `CompiledContext.budget_trace` | `ContextCompiler.compile()` | Compiler-level section budget: mandatory / capped / dropped section names and sizes |
| `ContextSnapshot.token_budget_json` | `ContextPrepareService` | Run-level stable_prefix / dynamic_tail character counts and percentage metrics |

`ContextSnapshot.token_budget_json` is **not** the compiler `budget_trace`. It is the populator's own measurement of stable_prefix vs dynamic_tail allocation. Future work may persist `budget_trace` into `ContextSnapshot` under a nested key (e.g., `compiler_budget_trace`); this is not yet implemented.

---

## 7. ContextDigest and context digest service (`server/src/modules/context/`)

Versioned derived cache of approved Memory + Policy content. **Not a source of truth.**

Supported `digest_type` values: `policy_bundle`, `project_folder`, `agent`.

Lifecycle:
1. Not auto-generated. Must be seeded by explicit `generate_*()` call.
2. `generate_*()` — idempotent: same source_hash → return existing digest unchanged.
3. `mark_*_dirty(...)` — no-op if no active digest. Called by
   `ProposalApplyService` inside the proposal-apply transaction.
4. Generation and dirty-marking take the same per-digest
   `pg_advisory_xact_lock` key (`policy_bundle:<space>`,
   `project_folder:<space>:<project_folder_id>`, `agent:<space>:<agent_id>`) so a refresh
   cannot reactivate a stale digest after a concurrent change marked it dirty.
5. Dirty digests are loaded for traceability, but are dropped at prepare time and
   never injected. Regeneration is explicit.

Project_folder/agent digest generation also verifies the target scope is still
`status='active'` in the same space and locks that row `FOR UPDATE`; explicit
refreshes/jobs fail closed for archived or missing scopes.

### Digest consumption

`ContextPrepareService` uses a digest only when it is usable:

- `policy_bundle`: status is `active`.
- `project_folder` / `agent`: the run agent's `readable_scopes` includes the digest
  scope, status is `active`, and every claimed `source_memory_ids_json` id still
  revalidates against live `memory_entries` for the same space/scope, active,
  undeleted, canonically readable by the run owner, and non-`highly_restricted`.

A digest is dropped when it is dirty, out-of-scope for `readable_scopes`, has
malformed/missing source metadata for non-empty content, or claims any stale or
ineligible source memory. Dropped digest content does not enter
`stable_prefix`, `source_refs_json`, snapshot digest version fields, or digest
memory read logs; the relevant section falls back to direct retrieval / direct
active policies.

### Context digest refresh

Explicit refresh gate. Regenerates a dirty (or stale) digest by calling the appropriate `generate_*()` method.

```
ContextDigestRefreshService(db).refresh(space_id, scope_type, scope_id, digest_type) -> ContextDigest
ContextDigestRefreshService(db).refresh_all_dirty(space_id) -> list[ContextDigest]
```

Never writes `MemoryEntry`, `Proposal`, or `Policy`.

### Digest refresh API validation

`POST /api/v1/context/digests/refresh` — `DigestRefreshRequest` enforces:

- `extra="forbid"`: unknown fields return 422.
- Empty object `{}` refreshes all dirty digests in the space.
- `scope_type` and `digest_type` must be provided together (neither alone).
- `digest_type` must be one of `policy_bundle`, `project_folder`, `agent`.
- `digest_type="project_folder"` or `"agent"` → `scope_id` required.
- `digest_type="policy_bundle"` + `scope_type="space"` → `scope_id` may be null.

---

## 8. Context Snapshot Population

Called immediately before adapter execution. server `ContextPrepareService` /
`PgRunContextRepository` builds and persists the run's `ContextSnapshot` row.

**Policy gate:** `context.inject_memory` is checked at the start of server context
prepare, before memory retrieval. Cross-space memory injection without a
`PersonalMemoryGrant` fires the hard invariant → DENY. A DENY stops context
population and propagates as a run failure. No memory is retrieved or injected
after a DENY.

Stable prefix strategy:
- Resolves `ContextDigest` rows for space / project_folder / agent via
  `loadDigestBundle()`, then filters them through the usable-digest rules above
- Falls back to direct `MemoryRetriever` / direct active policies when a digest
  is missing, dirty, out-of-scope, malformed, or stale
- SHA-256 hashes stored in `ContextSnapshot.prefix_hash` / `tail_hash`
- Compiler version: `context_digest.v1`

Stores in `ContextSnapshot`:
- `source_refs_json` — direct source refs plus usable digest refs only
- `retrieval_trace_json` — stage-by-stage trace from MemoryRetriever plus digest
  fields (`digest_used`, `digest_types`, `digest_versions`, `digest_dropped`,
  `digest_missing_types`, `fallback_to_memory_retriever`)
- `token_budget_json` — run-level stable_prefix / dynamic_tail character metrics (NOT `ContextCompiler.budget_trace`)

---

## 9. ProposalApplyService (`server/src/modules/proposals/applyService.ts`)

**Primary durable write boundary** for accepted proposals. Supports two additional write paths with explicit provenance controls (see write boundary table in section 1).

**Defense-in-depth gate:** `apply()` requires `accept_context` in `{"explicit_user_accept", "internal_seed"}`. Unrecognized `accept_context` without `bypass_source_monitoring=True` raises `ProposalApplyError`. Proposal payloads with approval-proof flags (`approved_by_user`, `approved_by_granting_user`, etc.) are rejected by `HardInvariantGuard._payload_flags_not_approval_proof` before reaching `apply()`.

Supported proposal types:
- `memory_create` → new active `MemoryEntry` (calls `MemoryInternalWriter.create_from_approved_proposal()`)
- `memory_update` → new version of existing memory, supersedes old
- `memory_archive` → sets `status="archived"` (no hard delete)
- `policy_change` → creates / supersedes `Policy` row
- `code_patch` -> dispatches through `ProposalApplierRegistry` to the memory-owned
  code-patch proposal applier
- `egress_granting_user` approvals → metadata-only `proposal_approvals` rows; no
  `egress_review` applier is registered yet

After applying `memory_create` / `memory_update` / `memory_archive`:
- Calls the digest dirty-marker for affected project_folder/agent memory scopes
- Calls `SourceMonitoringService.record_proposal_apply(...)` for provenance tracking

After applying `policy_change`:
- Marks only the `policy_bundle` digest dirty. Project_folder/agent digests are
  memory-only and never embed policy content.

---

## 10. Policy enforcement inventory

| Gate | Location | When |
|------|---------|------|
| Hard memory filter | `server/src/modules/context/repository.ts` and memory repositories | Every retrieval query |
| Read authorization | `server/src/modules/access/contentAccess*.ts` | Context assembly, direct reads |
| Policy-aware read gate | `server/src/modules/policy/decisionCore.ts` | Run context reads |
| Private memory placement | Policy hard invariant + memory applier | Memory proposal apply |
| Write authority boundary | `server/src/modules/proposals/applyService.ts` | Accepted proposals only |
| Agent memory scope | `agent_memory_policy.readable_scopes` | Context repository |
| Egress approval | `server/src/modules/proposals/applyService.ts` | PersonalMemoryGrant egress |
| Project Folder root validation | `server/src/modules/projectFolders/pathPolicy.ts` | Before Project Folder file access |
| Per-run execution lock | run worker/orchestration locking in `server/src/modules/runs/` | Run execution service |
| **context.inject_memory** | `PolicyGateway` in `server/src/modules/context/prepareService.ts` | Before context assembly |
| **context.render_for_runtime** | `PolicyGateway` in `server/src/modules/runs/orchestrationService.ts` | Before adapter execution |
| **proposal.create** | `PolicyGateway.enforce()` in proposals/projectFolders target modules | Before Proposal row insert |
| **proposal.apply** | `PolicyGateway.enforceProposalApply()` in `server/src/modules/proposals/applyService.ts` | Before accepted proposal side effects |
| ProposalApplyService accept_context | `server/src/modules/proposals/applyService.ts` | Defense-in-depth at apply() entry |

---

## 11. Deferred capabilities

- **Automation triggers**: `Automation` and `AutomationRun` support manual and schedule-triggered fire. Scheduled automations can carry same-space `AutomationCredentialGrant` pre-authorization. No external event trigger is implemented.
- **Vector/embedding search**: MemoryRetriever embedding stage is a stub that delegates to keyword.
- **Cross-space federation**: PersonalMemoryGrant exists but FederatedAccess / PublishProjection are not yet built.
- **Session condensing**: implemented. The `session_condense` background job runs
  the LLM condenser (`condenser_version="llm.v1"`, registry-backed scenario
  profiles plus per-agent prompt overrides) with the deterministic `pattern.v1`
  as fallback.
  Tool-call message preservation in the conversation window remains future
  scheduler scope (P6/P7).
- **ContextCompiler budget_trace persistence**: `CompiledContext.budget_trace` is not yet persisted into `ContextSnapshot`. Future work may add it under `token_budget_json["compiler_budget_trace"]`.

---

## 12. Automation boundary

`AutomationService.create/update/fire()` use `PolicyGateway.enforce()`. Manual
fire creates a queued `Run(trigger_origin="automation")` and an
`AutomationRun` link; it does not execute the run synchronously or bypass
existing runtime gates.

Automation schema is intentionally folded into canonical 0001 during foundation
hardening. No 0002 migration is expected for this branch.
