# Agent Attention

`server/src/modules/agentAttention/` owns a user-level read projection and personal
reading decisions. It owns no Run, Task, message, approval or delegation lifecycle.
Wire contracts are in `packages/protocol/src/agentAttention.ts`;
`semantics.ts` owns the pure identity, retry, grouping and personal-relation rules.
See [Agents](agents.md), [boundaries](../BOUNDARIES.md), and
[security/access](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md).

## Identity, responsibility and reasons

A work is a projection of actual Agent execution, identified by a typed
`{ kind, source_id }` plus its source Space. `work_key` is issued by the server;
clients carry it opaquely and never construct a command or infer authorization
from it. Only `execution_kind=agent` with an actual Agent becomes a member;
configuration alone and ProviderTask-only work create no idle Agent rows.

`createAgentWorkResolver` resolves authorized links in this order:

| Source facts | Work identity |
| --- | --- |
| Canonical Task execution link or Plan's source Task | `task`; a validated contract Task disambiguates multiple links |
| Nondelegated group with a Session, or a direct Session | `session`; separate Sessions remain separate even for the same Agent |
| Nondelegated group without a Session | `agent_group` |
| Delegation, parent/root, causal continuation or retry ancestry | The visible ancestor's work; retries stay in that work |
| Standalone Run or unresolved authorized lineage | `run`; hidden locators grant no fallback access |

Task creation `source_run_id` is provenance, not execution ownership. Each member
has one aggregate identity; automation, workflow and autonomy provenance does not
create a duplicate work. Explicitly superseded Room/direct retry results remain
historical members but supply no current reasons or unread results.

`mine` means a member Run owned/instructed by the viewer, a Task whose current
responsible actor is that user, or an open human reason assigned to that user.
Task responsibility reuses `projectWork.responsibleActorOf`, not Agent ownership.
`all_visible` broadens only the authorized read set; general visibility and
approval capability do not make someone personally responsible or grant commands.
Run status, canonical Turn state and Task/Loop state remain independent axes.
A succeeded/degraded turn with an open human question still needs an answer;
terminal execution and reading never imply Task acceptance.

Human reasons are typed `awaiting_answer`, `authorization`, `run_decision`,
`proposal`, `task` or `task_merge`, with their exact source and responsible actor.
Questions remain open until accepted human input on the visible Session branch
reaches that Agent; merely viewing, a failed send, or another recipient/branch
does not answer. Authorization and supervisor decisions use their owning paths.
Structured `resource` codes come from Run/Host/Turn readers: workspace,
predecessor/dependency, quota and other resource waits are not approvals and carry
no human responsibility. Task merge reasons use the owning blocked-outcome schema
and its responsible actor, separately from resource waits. No reason is inferred
from prose or logs.

Grouping gives a person's open reason `needs_you` priority, then executing work
`working`, then queued/blocked/resource/other-person reasons `waiting`, then
terminal unread work `recently_finished`, otherwise `idle`. Display order is
needs_you, recently_finished, working, waiting, idle. Inside each group the server
sorts by business activity descending, then work_key ascending for stable ties.
A child requiring the viewer promotes its top-level work and identifies the child.
Delegated Runs' own `awaiting_answer` questions are excluded by
`sessions/messagePath.ts` (`delegation_id IS NULL`): they create no personal reason
and do not promote the parent for that question.

## Readers and authority

`repository.ts` reads authorized source facts in batched queries,
with `runReadSql` (including Room and Project access), Task/proposal predicates,
and actual effective content levels. Session projection additionally uses the
Session owning reader's direct-user / active Room-roster gate. Full Run access
alone cannot expose another person's direct conversation. When a Run/group has a
Session, its group title uses the same Session read gate, including active status.
An unreadable or archived Session therefore falls back to a generic work title
unless an independently readable Task supplies its title. Its Runs fall back to
their own `run` work (or stay in their Task) with `run_result` subjects in place
of the reply `message`; those results are the already-delivered replies under
another identity, so they are read by default and never become a new notice
(`readModel.sessionDetached`). Standalone groups
without a Session retain their own full-access title. Summary-only members
have no message, question or Turn-body subjects. Member counts count only readable
Agent Runs; ProviderTask anchors never become unnamed Agent members. A visible
Run is never dropped just because an ancestor, retry predecessor, Task or Session
cannot be read. The indexed resolver retains its closest resolvable visible work,
or issues its own `run` identity on missing, ambiguous, cyclic or cross-Space
lineage; a retry chain with such a gap supersedes nothing. Inaccessible ancestor
and Session/Room/group/delegation locators are withheld; a fallback is not a new
content grant.

`readModel.ts` reuses the shared pure semantics with a per-batch identity cache,
batch Run indexes, one-pass retry supersession and indexed extra subjects. Plan
and autonomy joins each return at most one deterministic provenance row per Run;
a second defensive Run-id deduplication prevents member/result multiplication.
Task links and Plan source Tasks precede Sessions. Current attention excludes
explicitly superseded results while retaining historical membership.

**Capacity limit:** list/snapshot load all authorized lightweight candidates and
project identities/read state in the application, then send summary JSON to
PostgreSQL for retention, filter/count/sort/page. Source eligibility/grouping is
not pushed down and there is no recent-N cutoff. Real-PG fixtures cover 10,000
Runs and dense 2,000-member Sessions, not a production/multi-client two-second SLA;
candidate memory and serialization remain costs.
Refreshing a loaded multipage window rereads each page sequentially with fresh
cursors; every page request repeats the full-candidate projection. Its request
count and cumulative query cost therefore grow with loaded pages, including
mounted invalidation refreshes coalesced to one start per five seconds.
Each user tab opens its own aggregate SSE connection; the Web Lock coordinates
external alert delivery only. Full-candidate reread load scales with connected
users × tabs, rather than one shared reader per user.

Item/PATCH traverse only the authorized connected lineage, batching each frontier
with visited Run and Session/group sets. Task/Plan links seed traversal; explicit
ancestry, continuation and retry edges expand it. Indexed predecessor/Session
lookups and separately authorized dependency locators avoid per-row reads. The
list/item source snapshots are repeatable-read; PATCH uses the transaction and
subject lock below. No list member loads a full Turn body or tool/Host log.

Active work, open reasons and unread subjects survive the current-view window.
Ended/read work expires 24 hours after server business activity, including the
exact boundary. Reading cannot extend that time. History uses the same sources
and authorization, with optional inclusive `since` / exclusive `until` bounds.
GET list/item intentionally create a missing personal enablement baseline with
insert-on-conflict before opening their read snapshot. This is a personal reading
initialization write, not a business lifecycle change; later GETs cannot reset it.
An immutable per-user `agent_attention_baselines.enabled_at` suppresses ended
results older than 24 hours before first enablement; current open reasons and
new results on old Runs remain eligible. A later Space membership does not reset
this baseline.

## HTTP usage

List, item and read-state endpoints use the session user. Active Space is not aggregate authority;
query/body `space_id` selects an independently reauthorized source.

- `GET /api/v1/me/agent-attention`: `scope=mine|all_visible` (default mine), optional
  `space_id`, `project_id`, `group`, `view=current|history`, `since`, `until`,
  opaque `cursor` bound to scope/Space/Project/group/view/time filters, `limit` (50 default, 100 maximum). Returns `items`, all five
  complete `counts`, `next_cursor` and server `as_of`. Group filtering does not
  reduce counts. all_visible never broadens content or command authority.
- `GET /api/v1/me/agent-attention/item`: `space_id`, `kind`, `source_id`, optional
  opaque `runs_cursor`. Returns the current work and a child page (`boundWork`,
  from the projection's member index): the work's own Task/merge reasons and
  subjects first, then member Runs each followed by exactly the reasons and
  reading subjects that belong to them, cut so `runs`, `reasons` and
  `read_states` each stay within the wire cap of 100. A Run and its subjects
  share a page unless they alone exceed a cap; the remainder then continues on
  the next page, which clients append. A subject never precedes its Run. The
  list and stream use the first page of each work. `visible_run_count` is the
  full authorized member count; `runs_next_cursor` advances the window. Missing, deleted,
  hidden and cross-Space source identities return 404.
- `PATCH /api/v1/me/agent-attention/read-state`: strict body with `space_id`,
  typed `identity`, exact displayed `subject`, `state_version`, and
  `action=read|unread`. `user_id` is rejected. Returns the updated subject state;
  stale reading decisions or changed source revisions return 409 with `current`.

- `POST /api/v1/me/agent-attention/views`: strict body with `space_id`,
  `session_id` and 1–200 `message_ids` a conversation surface displayed. The
  server resolves the authorized work and current revisions those messages
  belong to and records a read for each one still unread, a manual unread
  included; unknown, unauthorized or already-read ids are ignored and the
  response is `{ read_count, read_states }`: only the exact source revisions and
  reading versions actually written by this report are returned, never current
  versions of skipped or conflicted subjects. This is how every surface — Room page, Project
  sidecar, direct chat and the Agent Work detail alike — says what was seen.

Opening a parent summary grants no bulk acknowledgement, and child pages do not
write reading state. Reading does follow chat order within one transcript: each
readable Session of a work has its own read cursor, the latest of (a) the newest
`message`/`run_result` subject of that Session the person confirmed on any
surface and (b) the person's own latest `role='user'` message in that Session —
replying is reading everything before it there. That Session's older replies and
results are read (`readModel.ts`, derived per read from `messages` by
`(space_id, session_id)` through `ix_messages_space_session_created`; nothing is
written for them), so the newest reply of a long Room conversation is enough and
history seen or answered elsewhere does not stay unread. A subject at the same
instant, anything newer than the cursor, replies in another Session of the same
(Task) work, a delegated child Run's own `run_result` (not a reply in its parent's
transcript) and the non-sequential subjects (task, merge, proposal, authorization,
decision) keep their own state. A manual unread holds until the next view of that
message or an own reply in its Session made after the decision
(`agent_attention_read_states.updated_at`). A manual
unread increments the version, so an older preview effect cannot consume it;
a later explicit open confirms the new version. A new attempt or message revision
also invalidates the older callback. Source revisions are compared for equality,
including attempt identity, never ordered by digest or across Run event indices.

`readStateService.ts` owns the transaction and per-user/subject advisory lock;
`repository.ts` owns CAS persistence as one insert-or-update statement: version 0
may only create an absent row, a later version may only update the row at
exactly that version, anything else returns no row and the service answers 409. Read-state changes also initialize a missing
enablement baseline through this repository within the same transaction; an
existing baseline is never reset. `agent_attention_read_states` has User and
Space FKs, a logical subject unique index and a user/Space lookup index. Polymorphic
source references are verified from live authorized work, never from reading rows.
Read records cannot resurrect removed sources or revoked membership. Baselines
and reading rows contain neither content nor business lifecycle state; only this
module writes them. No reading operation answers, approves, resumes or completes
anything. Operation descriptors are navigation hints, not command authority.

`GET /stream` and `/snapshot` add the aggregate feed described under
[Global aggregation and delivery](#global-aggregation-and-delivery).

## Verification

`server/test/agentAttentionDb.test.ts` and `agentAttentionLineageDb.test.ts` use the shared real PostgreSQL fixture,
`domainSeeds`, `resetTables` and `moduleServer`; they protect questions, retention,
attempt revisions, retry members and reading on their production paths.
`agentAttentionSemantics.test.ts` stays pure and covers only the shared functions
production calls (resolver, retry supersession, grouping, `mine`, baseline).
See [Commands](../COMMANDS.md) for package-scoped verification and migration
creation. Migration `0001_agent_workbench.sql` includes the attention read-state
tables and the retry-predecessor and session-lookup indexes (the unpublished
development migrations were folded into it, together with this plan's other
schema changes). These
are generated from Drizzle declarations and append to the baseline; no running instance migration
is part of development verification.

## Shared conversation entrypoints

The existing web conversation area now supports an explicit source `spaceId` on
ConversationSurface/preflight, propagated through nested reads, input resources,
Proposal decisions, Turn streams and Run controls. Direct ChatPanel uses its
Agent's source Space. `ConversationScope` aborts work on destination changes and
`ConversationLink` keeps navigation in the source Space. RunDetailPage and
ConversationRunControls share `runs/useRunActions`; authorization reconciliation
never also resumes a Run, and every command rereads its canonical Run. A failed
reread after a successful command is a separate `refreshError` note, not a command
failure, so the person is not invited to repeat an applied command.
Every conversation surface (ConversationSurface, direct ChatPanel) calls
`useAttentionViewing(spaceId, sessionId, { messages, ready })`: once its transcript
has rendered it hands the displayed message ids, each with a fingerprint of the
shown body and open-question flag (`shownVersion`, the inputs the server's message
revision covers, never the revision itself), to the Shell provider's `ViewReporter`
(`agent_work/viewReports.ts`). Each mounted surface registers separately; a
Session reports the union of its surfaces, and one surface leaving or changing
its set never removes another's. Each Session debounces and runs one serialized
loop of `POST .../views` batches of at most 200 ids, sending only ids whose
displayed fingerprint that surface has not yet reported successfully while the tab
is visible. A reply updated in place (the placeholder written while a Room waits
for approval, then the final body under the same message id) is therefore reported
again; rerendering an unchanged body is not a new view and cannot consume a manual
unread, and a paused open's surfaces still wait for another open. A body that
changes while its report is in flight stays unreported. Direct chat's client-only
streaming placeholder ids are not reported; everything displayed
is reported again when the tab returns or reconnects. A failed batch stays
unreported and is retried by the next display change or return. It never learns
revisions or work identities. Reading reports survive delivery-coordinator
initialization and StrictMode effect
replay; opening a conversation never suppresses its new-revision alerts. A surface
outside the provider reports nothing. Agent Work consumes these entrypoints; the
authenticated Shell owns the aggregate provider described below. See
[Conversation](../architecture/CONVERSATION.md) for the existing sender/update
paths and explicit preflight behavior. The aggregate provider owns no conversation content or execution lifecycle.

The reusable Room composer scopes file search and snapshots as well as image
input. RunDetailPage keeps its original action entries and refreshes an existing
Run in the background; the conversation controls retain their explicit stop
command. Signal composition uses the compatible listener-based helper.

Shared Room/Run request controllers are also released after normal completion.
The standalone RunDetailPage has remaining global-Space consumers documented in
[Runs and outputs](../architecture/RUNS_AND_OUTPUTS.md); it is not yet a general
cross-Space embedded Run detail surface.

## Web workbench

`apps/web/src/modules/agent_work/AgentWorkPage.tsx` is registered as a personal
built-in module at `/agent-work`, inside RequireAuth. The Global Rail and Home
link there without a Space prefix. No mobile primary tab is added. Filters
(scope, source Space, Project id, group, current/history and history start date)
are local state; they never change URL active Space. Selection, expanded members
and list scroll position belong to this page, with no automatic selection.

The page is built from the shared UI primitives other modules use (the Tasks/Runs
page header, `Select`, `Input`, `DatePicker`, `Label`, `Badge`, `EmptyState`,
`Skeleton`), not module-local controls; copy stays in the `agent_work` i18n
namespace. Freshness is a status badge beside the delivery controls. In the detail
pane the member (Run) list is a bounded, separately scrolling section (at most
40% of the viewport while a reply conversation is mounted) so the embedded
conversation keeps its own height instead of collapsing and spilling behind
the rows; without a conversation the member list takes the remaining height.

`useAgentWorkList` subscribes to the authenticated Shell's `AttentionStore`.
The personal window comes from the user stream; mounted filters/history/cursor
windows are reauthorized with the existing list endpoint by that same store.
Explicit refresh and completed user actions also request that store. It uses
server groups/counts/cursors
and isolates request generations; the page owns no polling loop or stream. List
reading-state reconciliation accepts a mutation response only for the same source
revision (including Run attempt) and a strictly later state version, so a delayed
response cannot mark a newly arrived result read, undo a later manual unread,
or replace a cursor-derived read projection at the same stored version.
List refresh rereads the number of already loaded pages using fresh server cursors,
then replaces the list window only after every page succeeds. It keeps existing
content, row identities within a group and the selected detail while loading.
Filtered windows are discarded when their last listener unmounts, so changing
filters resets those windows. The personal window is retained: only a replacement
stream page received without personal-list listeners resets its pagination to the
first page. Without such a frame its loaded pages survive and are reread on remount
with fresh cursors. Switching to a filtered/history view removes personal-list
listeners, so returning to unfiltered personal work after a replacement frame
requires Load more again. This is expected window behavior, not loss of server
work or a change to global reminder eligibility. A shorter server collection can shrink it. Offline events and failed
list reads retain the mounted detail, composer draft and focus with an explicit
stale/error label. A denied list read removes that detail and clears selection;
recovered access requires another explicit open. Its own denied reads also remove
protected content. Online recovery rereads the list without
reopening the detail or confirming a new source revision. Empty, denied, failed and offline states have distinct copy.
Run summaries now include optional bounded Agent display name (full access only),
immutable Run runtime key and start time. Older payloads without these fields
remain valid. The list computes only presentation duration against server as_of,
never work classification; `formatWorkDuration` uses the existing locale-aware
number formatter for seconds, minutes or hours, with at most one fractional
digit for minutes/hours. A truncated member window labels duration as partial,
and unknown times/runtime are labelled as unreported.
Projects are currently filtered and labelled by their exact id, not a fetched
Project title. Space names reuse the user's already loaded membership list.

`WorkDetail` reauthorizes the typed identity on open/refresh and pages child
members with the server cursor. Reasons, Proposal links and the Task-merge
acknowledgement use the reasons of every loaded page (first page then appended
pages, each exact reason once), so a later page's pending Proposals appear once
their Runs are loaded; the list row keeps its first-page reasons. A collapsed
child reads no Turn and acknowledges no result. `WorkConversation` uses ConversationSurface for Room Sessions (with
execution preflight only for writers), and the existing ChatPanel for direct
Sessions. Source Space flows through ConversationScope, including nested requests,
links, composer and Run controls. A Room reader gets the shared transcript in
readOnly mode, with no composer, Proposal decisions or discussion mutations.
No read initializes a Session or execution context. The actual Room manager / direct
Agent is labelled above the surface, with a complete source-Space conversation link.

Without a reply Session, expanded full-access members use `WorkRun`'s bounded
canonical Turn read and ConversationRunControls, not RunDetailPage. These controls
continue to use `useRunActions`. The workbench passes source membership and user
identity as UI eligibility filters: Run stop/abandon/supervisor resume require owner
or instructor standing; policy-gate resume also checks the recorded risk against
membership, using the shared `POLICY_APPROVER_MAX_RISK` values from protocol;
missing/invalid risk and insufficient approval authority have distinct reasons.
Authorization decisions require a Space owner. Shared Room retry omits its
callback only for readOnly surfaces and delegated Runs, independently of Run
owner/instructor standing or Project writer status. Agent Work sets readOnly to
`!room.viewer_can_write` for its own embedded surface; original Room page and
sidecar callers keep their existing defaults. The server retry path checks
visibility and the original persisted input, not Project write authority. Run standing reasons appear only on active Runs,
not during loading or beside completed results. Shared control copy belongs to
`conversation_ui.run`. The server reauthorizes
all commands. Task and Proposal lifecycle review links go to their owning pages;
there is no synthetic Run message sender. Summary access never mounts Turn bodies.

`useWorkReading` confirms only successfully rendered expanded Run
results/decisions and authorization reasons, or Task/merge state actually
displayed; message views are the embedded surface's own report through
`useAttentionViewing`, and the hook merely remembers which messages this open
showed so a manual unread targets them. It sends the source revision and
state_version, never a work-wide read. Each explicit open freezes its reading
revisions; an item refresh cannot acknowledge a newer version while the preserved
transcript may still show an older body. Newly paged subject identities extend
that snapshot; changed revisions require another explicit open. Manual unread
pauses the current open and the conversation surfaces mounted under it
(`AttentionViewingGroup`); other surfaces showing the same Session keep reporting
what they display. It waits for every already-issued report of that Session, and uses only their returned versions for the same frozen source revision.
Reports already issued by an earlier open of that Session remain tracked until
settled, so closing and immediately reopening cannot leave an older read racing
the new manual decision.
Pending view timers, unsent batches and display/visibility changes cannot issue
another report during this decision. A failure of a report it awaited stops the
manual decision; an earlier, already settled failure does not; reopening the detail starts a new reporting lifetime. Account disposal
aborts reports and cannot continue with an unread write. An explicit unread
also accepts a newer reading version already confirmed by an item refresh for
the same frozen source revision, including conversation view reports; automatic
confirmation does not inherit it. An unconfirmed race or a different source
revision still conflicts. Successful manual unread returns to current
work with only the history time window cleared (group/Space/Project/scope retained).
A 409 preserves current from the server, refreshes the item and pauses
automatic confirmation until a new explicit open. Undisplayed child subjects and
Proposal bodies represented only by links remain unacknowledged. A failed content
read does not confirm its subject. Detail unmount cancels its scoped operations.
There is no browser cache of conversation content in this module.

Arrow keys move list focus; native Enter opens the focused item; R focuses the
reply editor, U marks the open work unread, and Escape returns. Inputs, textareas,
selects, popup triggers (`aria-haspopup`) and editable content retain their keys. Page shortcuts ignore already
handled events, targets outside the page DOM (including React portals), and
dialog/menu/listbox/option/menuitem ancestors. At narrow widths the mounted list
is hidden while detail is open; Back preserves filters and scroll. All new copy
uses existing en/zh-CN resources and date/number formatters.

Web tests: `AgentWorkPage.test.tsx`, `SharedConversation.test.tsx` and
`agentAttentionApi.test.ts` under `apps/web/src/modules/agent_work/`, plus
`apps/web/src/__tests__/navigation.test.ts`. Browser/theme/real-host acceptance is
separate from these deterministic tests. The capacity limitation and standalone RunDetailPage scope limits above also
apply to this workbench.


## Global aggregation and delivery

`streaming/agentAttentionStream.ts` owns authenticated
`GET /api/v1/me/agent-attention/stream`. `agentAttention/snapshot.ts` reuses the
canonical facts, projection and retention query, including old active work and
subjects beyond the 50-work / 100-child display windows. `pageWithSignals` adds
complete unread-work counts and eligible keys to the internal query result;
list DTOs remain unchanged. Its announceable signals are derived from every
authorized work regardless of the retention window, each flagged with the work's
current `mine`. `/snapshot` returns the same authorized aggregate as
one silent JSON frame for connection failure recovery. Neither endpoint uses
active Space as authority or exposes message bodies.

A connection emits a silent `attention.snapshot`, then waits 2,000 ms **after each
read and frame write, including any drain wait**, before rereading. Identity, membership and source visibility are
rechecked. Complete group/unread counts accompany every live frame. Changed data
sends `attention.invalidation`; only a changed personal display window (items or
cursor, excluding as_of/count churn) carries a replacement page. Snapshot/resync
always include it; unchanged data sends `attention.heartbeat` without a page. More than 100 new notices produces a silent `attention.resync`.
Revoked sources disappear on replacement; denied account identity closes with
`attention.denied`. Only response close/destroyed ends a healthy connection.
A false `write` result is backpressure: the writer awaits drain before another
read/write, keeping at most one pending frame. Abort cancels drain/timer waits.
Post-hijack read/write failures are logged and end the response without escaping
the handler. The immutable reading baseline is initialized once per connection,
not with an INSERT on each reread. No client means no scan, Scheduler, Job or
independent event log. `seq` is per connection,
never a global business cursor. Retention expiry participates in the version.
The full-candidate capacity limitation above still applies to each connection;
the two-second pause is a reread interval, not a response-time guarantee.

`core/Shell.tsx` mounts `AgentAttentionProvider` for the authenticated account.
It owns the personal collection, mounted filter windows, reconnection and request
generations. Filters cannot change global personal reminder eligibility. A failed
connection tries a silent authorized snapshot, marks freshness, then retries
with capped exponential backoff (5 s doubling to 60 s, equal jitter), reset by
the next applied live frame; online reconnects, while becoming visible reconnects only when
freshness is not live. Live foreground returns retain the connection. Offline keeps mounted content and
drafts. Reconnect snapshots also reread mounted filters. Ordinary invalidations
coalesce filtered/multi-page list rereads to at most one start per 5 seconds;
explicit refresh and reconciliation bypass that throttle. This is demand-driven,
not a polling timer; disposal cancels deferred reads. When no list listener is
mounted, a replacement personal stream page discards prior pagination, cancels
deferred/in-flight list reads and resets the window to one page. Late list
responses cannot replace that page. If a multipage personal window survives
without a replacement frame, remounting the list rereads its loaded pages with
fresh cursors. Count-only frames still
update the default window's group totals immediately. Denial clears protected
windows/counters; logout/account replacement aborts connections and requests and
disposes content, native notifications and audio. Late callbacks cannot refill the
previous account. The client reuses the existing SSE reader, now including
multiline `data:` frames. Global Rail and Home show needs-you/unread-work counts;
Agent Work also shows freshness and delivery controls.

A notice is a content-free identity of the exact source revision (subject kind,
id and revision), plus the current `work_key` it belongs to. Its key excludes the
work identity and the mutable answer/decision/finished/failed classification:
answering a question without changing its source revision cannot announce that
same message again as finished, and a work changing identity (Task link, archived
Session fallback) or becoming the viewer's keeps its keys. A new source revision
still has a new identity. A frame announces only keys absent from the previous
read whose work is currently `mine`; because keys exist independently of the
retention window, old work re-entering the personal window (new activity, a
newly blocked Task, a manual unread from History) announces only its genuinely
new revisions. Classification
comes from owning facts. Answers/decisions require
the projected personal responsible user; ordinary chat completion uses the
shared Turn state. Initial/reconnect/resync reconciliation is silent. A manual
unread restores server reading state without manufacturing a new event. Delivery
never writes read state. Active WorkDetail invalidations reauthorize content
without replacing its open lifetime, draft or frozen acknowledgement revision.
It replays already loaded child pages with fresh cursors, retaining the prior
window until the complete refresh succeeds. Unchanged item/child data keeps its
object references, so unrelated invalidations do not reread WorkConversation or
WorkRun content or remove focused children. Changed work still refreshes.
An explicit detail refresh also retries nested content reads when its summary is
unchanged, and a successful Run read clears the earlier transient read error.
ConversationSurface and ChatPanel report displayed messages through optional
`useAttentionViewing`; outside the provider it is inert. Displayed/read state and
reminder delivery are separate: an open panel does not prove the person noticed
a new result, so new revisions still alert even when a view report beats the
aggregate stream poll. Initial/reconnect/resync snapshots remain silent, and
reading changes alone do not manufacture a new revision.

`attentionDelivery.ts` uses a per-user Web Lock for one same-origin sound/system
sender and BroadcastChannel for opaque delivered/toasted revision identities
and the person's sound/desktop on/off choice only. Each tab retains its own
authorized aggregate stream; no content, permission grant or active-view hints
are broadcast. A held lock is released on account
disposal/tab exit and the queued tab takes over.
Delivered identities are browser memory, bounded to
2,000, and are not persisted business facts. After a visible toast is shown,
the tab broadcasts `{ type: 'toasted', key }` (revision identity only). Other
same-account tabs remove that pending identity and remember it in their bounded
toastSeen set; receiving it suppresses later foreground replay and delivery in
another visible tab. This is separate from sound/system `delivered` identities.
Two visible windows receiving the same frame almost simultaneously can both show
a toast before either broadcast arrives: cross-tab toast deduplication is best
effort, not an atomic guarantee. The Web Lock remains for sound/system delivery;
a visible follower can still show a toast while its leader is hidden.
Hidden tabs do not record a local toast as shown; up to 100 new identities wait
in account-local memory until becoming visible. Before flushing, the provider
skips a work marked `unread=false` only when its authorized window has one page and no loading, error,
pending invalidation timer or dirty reread. An unsettled/multipage personal window
means unknown and cannot be overridden by a filtered window's read value. This is
intentionally conservative even after a multipage refresh finishes: a foreground
tab may show a pending reminder for work already read elsewhere rather than risk
silently consuming a genuinely new reminder. Otherwise
the personal item's state takes precedence; if absent, only mounted, settled
single-page filtered windows can establish read status. Missing/unknown work
keeps its reminder. This filter uses work-level `unread`, not the notice's specific
subject: opaque notice keys cannot identify that subject. An older pending notice
can consequently accompany a newer unread subject on the same work. No read
state is broadcast or written by this filter.
Already open objects still receive new-revision alerts. Reconciliation/denial/account
disposal clears pending identities. They contain no message text and never change
reading state. An enabled background desktop/sound alert and a later in-app toast
are deliberately separate channels; `delivered` alone does not consume the toast,
while another tab's `toasted` does. Without browser coordination (including absent
BroadcastChannel or rejected channel creation), only single-tab in-app deduplication
is available; sound/system delivery is disabled with explanatory copy. No
localStorage lock or cross-device guarantee is claimed.

Sound and desktop switches default off for each login. An explicit choice in
the delivery tab is broadcast to same-account tabs and kept in
`rainver:agent-attention-alerts:<user>` localStorage, which logout residue
cleanup removes; followers display it but cannot change it. When the lock passes
to another tab, that tab delivers desktop alerts while `Notification.permission`
is `granted`, and arms sound on its next click or key press (browsers require a
gesture before AudioContext plays), showing that it is waiting. Only an explicit
toggle asks Notification permission. Rejection or a failed alert shows a separate
delivery-limited badge; it is not a data-freshness state and never triggers a
reconnect. Rejection cannot block lists/badges. Notifications use generic
localized categories and a link to Agent Work, never message text. Account cleanup
closes them. Background throttling/browser notification behavior remains best
effort; closing the webpage stops delivery. Native-browser behavior, multi-tab
handoff and the enabled sound/desktop paths require real-device verification.
This includes loading more personal work, leaving the workbench, then returning
from a background tab after a new result: the in-app reminder must still appear once.

Tests: `agentAttentionStream.test.ts` exercises frame deltas/lifecycle;
`agentAttentionSnapshotDb.test.ts` uses real PostgreSQL, including HTTP snapshot,
live SSE membership revocation and complete-candidate cost. Web Provider,
coordination and API tests live under `apps/web/src/modules/agent_work/`;
`src/__tests__/shell.test.tsx` protects one stream across navigation and rail counts.


## Manual acceptance (user-run; no results implied)

On 2026-10-22 the user confirmed acceptance of the scenarios available in their
current usage; remaining scenarios are observed during continued use. The
implementation plan and temporary ledger are retired. The checklist below is
retained for future verification, not a claim that every scenario was executed.
The subsequent reading-sync, open-work alert and title-visibility fixes have
automated regression evidence; their deployment and live-session verification
are separate from that acceptance statement.

Automation does not establish browser/native-runtime behavior. Use desktop and
narrow widths, English/Chinese, light/dark themes, long titles, keyboard/scroll,
reordering during input and failed/denied reads. Keep supplied reference images
and private documents outside the repository. In a real Project with three
Agents exercise normal completion, question/reply/re-execution, an eligible
approval and a genuine paused decision, resource recovery and delegation.
Record intervention-to-notice latency, page switches and repeated/stale reminders;
compare the same tasks through existing paths before claiming efficiency gains.

1. With at least 50 personal works, keep the stream open for minutes; observe
   snapshot/heartbeat/invalidation across large frames without repeated reconnects.
2. A hidden leader and visible follower must deliver a visible toast; a single
   background tab must retain its arrival until foreground, keeping a live stream.
3. Load more detail children and focus one; unrelated/self invalidations and
   concurrent paging preserve children/focus and update changed work. Keep drafts
   offline.
4. Check actual workspace/predecessor/dependency waits recover by their owning
   mechanism when the condition clears, without an approval or duplicate send.
5. Inspect frame size, coalesced filtered rereads and query latency under real
   history/membership load; fixture measurements are not a capacity promise.
6. Across Home/other pages/workbench and narrow-screen return, preserve correct
   counts, filters, selection and drafts. A Project filter cannot silence another
   Project's personal reminder; reconnect snapshots do not announce old results.
7. Check missing Web Locks/BroadcastChannel degradation, explicit enablement,
   refusal/revocation of sound/desktop permissions, background throttling and sender
   exit/handoff. Background desktop and later in-app toasts are separate channels.
8. Logout/account replacement clears prior content/pending identities; late callbacks
   do not refill. Revoked Room/Space/Run access removes previews/actions and hidden
   children. Leave the default notification policy unchanged pending device results.
9. Two tabs show one toast after the first tab's toasted identity arrives; switching
   tabs/repeated frames do not replay it. Check side-by-side windows and document
   the best-effort near-simultaneous arrival race, not an atomic guarantee.
10. Read work in A; after B receives a settled single-page authorized read state,
    foregrounding B does not replay it. No filter writes reading state or assumes
    out-of-window work read. Multipage/unstable windows intentionally retain reminders.
11. Load more personal work, leave the workbench, background the tab and wait for a
    new result. Foreground still shows one in-app reminder; returning uses the
    current window. A mounted multipage pending refresh must not swallow it either.
12. Load more personal work, switch to a filtered view and receive a replacement
    personal page. Returning to unfiltered personal work shows the first page;
    Load more restores further pages. Global counts/reminders still cover the
    complete authorized personal collection.

## Integration verification commands

Run from the named package, with Node 24. Persistent tests use shared real
PostgreSQL; unavailable tests are reported skipped, never replaced by a fake DB.
The server suites protect source/ACL/causality/read CAS and canonical streams;
protocol tests protect contracts; web suites protect real store/Provider delivery,
workbench reading/lifetimes and shared conversation consumers. Browser APIs and
network boundaries use controlled fakes, not a replacement aggregate implementation.

```bash
# server/
pnpm exec vitest run test/agentAttention*
pnpm exec vitest run test/frontendSupport.test.ts test/turnStream.test.ts test/turnStreamFrames.test.ts
pnpm exec vitest run test/authorizationRequestService.test.ts test/acpVendorQuestion.test.ts
pnpm exec vitest run test/agentGroupsLifecycleProjector.test.ts test/roomsDb.test.ts
pnpm exec vitest run test/agentGuides.test.ts
pnpm run typecheck

# packages/protocol/
pnpm run typecheck
pnpm test

# apps/web/
pnpm exec vitest run src/modules/agent_work
pnpm exec vitest run src/__tests__/shell.test.tsx
pnpm exec vitest run src/core
pnpm exec vitest run src/__tests__/navigation.test.ts
pnpm exec vitest run src/modules/agent_groups/__tests__/AgentGroupsPage.test.tsx src/__tests__/assistant-chat.test.tsx
pnpm exec vitest run src/modules/conversation/ConversationRunControls.test.tsx
pnpm exec vitest run src/modules/conversation/__tests__/ConversationTurn.test.tsx
pnpm exec vitest run src/modules/runs/__tests__/RunDetailPage.test.tsx
pnpm exec vitest run src/modules/projects/__tests__/ProjectChatSidecar.test.tsx
pnpm run typecheck
pnpm run build

# repository root
git diff --check
```
