# Token Usage Metering

Token metering is an append-only server authority owned by
`server/src/modules/usage/`. Run rows do not store token accounting;
`token_usage_events` is the sole accounting source. Provider prompts, completions, messages, response content,
credentials, stdout/stderr, and raw transcripts are never stored in the usage
ledger.

## Write Path

All generation, embedding, and rerank requests use the server-owned
`completeProvider*` functions or a provider-proxy lease. Their metering context
is mandatory and is validated before provider network I/O. The usage repository
is the only code that inserts `token_usage_events`.

Attribution is resolved before normalization:

- direct authenticated user calls and CLI history imports become owner-private
  events;
- Run/Agent calls snapshot the source content owner, workspace/project scope,
  visibility, disclosure level, and active grants at call time;
- active `selected_users` grants and `space_shared` disclosure-upgrade grants
  are copied to `token_usage_event` grants in the same SQL statement as the
  event insert;
- an unknown owner fails the write;
- an ownerless event is allowed only when the caller explicitly marks a
  Space-system task and the resulting visibility is `space_shared`.

Provider retries and provider fallback do not create events for failed
attempts. A successful provider response creates one event with an idempotency
key. Managed provider invocations record each observable call; provider-proxy
leases record bounded usage metadata from compatible upstream responses without
persisting request or response bodies. CLI history imports use stable
transcript-derived idempotency keys and are marked as transcript lower bounds.

## Read Path

All future usage checks, summaries, budget decisions, thresholds, routing
history, and monitoring must read `token_usage_events` through the usage
repository. Run- or attempt-level rows are lifecycle records only; do not add
token accounting fields to them, read accounting from `output_json`, or issue
feature-local queries against a legacy snapshot. A new run-scoped projection
belongs in `PgUsageRepository` so normalization, null handling, and ledger
semantics stay centralized.

Every active member can open `/usage` from the Usage card in personal Settings.
It intentionally stays off the primary rail. The default view is `Mine`;
`Shared in space` includes only visible `space_shared` events; `All visible`
combines owned, shared, and selected-user-granted events.

The repository applies the canonical `token_usage_event` SQL predicate before
token or cost aggregation. Workspace/Project scope is evaluated independently
from visibility. Owners always receive full access. Non-owner `summary` access
contributes only to a `Shared summary` aggregate; raw event, session, dimension,
and budget-subject drilldowns require effective `full` access. Provider, model,
subject, session, accuracy, channel, and custom-dimension filters also exclude
summary-only rows so filters cannot be used to infer hidden dimensions.

Space owner/admin roles do not independently bypass event reads. The canonical
creation-time Space oversight mode is the sole read-only exception: eligible
owner/admin members receive the configured `summary` or `full` disclosure for
otherwise-hidden events in that same Space. Instance administrators have no
cross-Space detail mode. The separate `/usage/operations/totals` endpoint
returns only de-identified totals across the requested time range.

## Pricing, Imports, And Budgets

Managed chat calls copy pi-ai's catalog-derived USD total into
`estimated_cost_usd`. The adjacent `cost_accuracy` column records whether pi-ai
actually matched the requested model to a rate: `catalog` retains the amount,
including a genuine zero, while `unknown` stores a null amount. This fact comes
from the adapter's catalog lookup and is never inferred from whether the number
is positive. `cost_details_json` retains the rounded input, output, cache-read,
cache-write, and total amounts plus `source=pi_ai_catalog`; it carries no second
accuracy field. `usage_accuracy` continues to describe provider token evidence,
not the locally calculated cost. Catalog-less custom models, CLI usage,
embeddings, and reranking intentionally remain uncosted.
There is no local pricing-rule table or second calculation path. Token counts
remain immutable accounting facts. Anthropic's
`cache_creation_1h_input_tokens` is persisted as a priced subset of
`cache_creation_input_tokens`; it is exposed in event and aggregate DTOs but is
not added again when deriving total tokens. The dashboard's budget preview is read-only
projection; usage recording remains fail-closed for managed provider calls.
Routing and budget SQL currently aggregate `estimated_cost_usd` with `sum()` and
therefore still swallow the known/unknown distinction. The intended consumer is
funding-aware routing, deferred in
[deferred-register.md](../.agent/tasks/deferred-register.md); this phase records
the provenance without changing routing decisions.

The current CLI history preview/commit flow supports managed Claude Code and
Codex CLI credential profiles. Uploaded archives, server-path imports, scanner
manifests, generic/manual event imports, and cross-instance bundle ingestion are
reserved by protocol/schema contracts but do not have active product endpoints.
Imported event types are therefore representable without making those future
ingestion paths available today. Aggregations currently query the append-only
ledger directly; there is no persisted daily/monthly rollup table.

Current user-facing routes include summary, timeseries, event, dimension,
subject, session, budget-preview, and managed CLI history import endpoints.
Instance operations have only the de-identified totals route.

## Database Baseline

Schema authoring lives in `server/src/db/schema/usage.ts`. Regenerate the single
Drizzle baseline and `server/migrations/0001_baseline.sql` with
`pnpm run schema:generate` from `server/`; do not edit generated SQL or add a
second migration.
