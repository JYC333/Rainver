# Module: Library

## Status

**IMPLEMENTED** — frontend reading surface lives in
`apps/web/src/modules/library/`. Cross-source delivery is owned by the
`informationDigest` backend module; raw collection and per-source briefing
reads remain in Sources. Document and annotation reads use the shared Reader
API under `/api/v1/reader/*`.

Reader annotation creation has no visibility picker. An annotation inherits its
document's Space, `project_id`, and visibility; annotation-derived Evidence then
inherits the annotation's scope and access policy.

## Purpose

Library is the per-user reading home for Sources-derived content inside a
space. It owns the user experience for source item streams, Library-level
digests, and the single-item reader route, while Sources continues to own the
source pipeline, subscription model, data model, and API.

## Owns

- Library shell (`/library`): Shell scene sidebar navigation for reading
  sections; defaults to `/library/reading` (the cross-day pending recommendation list). The navigation labels it Reading. All material uses `/library/reading?view=all`; legacy `/library/items` and type filters remain reachable under By type.
- Personal briefing at the top of personal Reading (`PersonalBriefingPanel`,
  owned by Information Digest's briefing kernel): collapsed to status and
  overview so the list stays within reach; not shown in a Project's Reading.
- Per-user item stream (`/library/items`): source-scanned items from sources
  the current user follows, items those sources delivered while the user
  followed them (historical eligibility, below), plus manually saved
  unconnected URLs created by the current user. A personal URL save is
  deduplicated per owner (`uq_source_items_active_*_personal` include
  `owner_user_id`): saving the same URL again returns the saver's own item,
  and another member's private save never blocks or reveals anything; a
  Project save is unique per Project and answers a conflict on an item the
  saver cannot read with 409 and no detail. Library uses
  `source_item_user_states.library_status`, `read_status` and `read_origin`;
  absent state rows render as `new/unread`.
- Reading eligibility after leaving a source. Every period in which a person
  received a channel is a row of `source_channel_subscription_windows`
  (`subscribed_at`, closed by `unsubscribed_at`), opened and closed by each
  subscription transition (`sources/channels/subscriptionWindows.ts`); leaving
  and rejoining adds a period and never overwrites an earlier one. Leaving
  (`POST /api/v1/sources/channels/:channelId/subscription {status:"muted"}`,
  the Sources page "Sources you follow" list) stops new items and digest
  delivery; items first seen inside a closed period stay readable in Library,
  the Reader (items, snapshots, Project annotation lists), Evidence and
  Source-derived artifacts (`source_reader_document`, `source_raw_snapshot`:
  get, list and export), through one gate in `sources/sourceItemAccess.ts`.
  Both a live subscription and a closed period hold only while the
  connection still admits the reader: archiving or deleting the connection,
  archiving its channel, or narrowing its visibility/grants past them ends
  both. Already-downloaded offline copies are outside this. A single
  document (the Reader, a Source-derived artifact and its export) follows the
  connection's consent (`sourceItemDocumentReadableClause`): besides the
  subscriber rules above, the connection owner, a named reader, and a Space
  owner/admin reviewing where `allow_space_admins` is not false may open it.
  The personal Library listing stays narrower: subscriptions only.
- Today's reading counts (`pending_reading_items`, `new_items_today` in the
  home summary) are the viewer's own: items readable to them through the
  Library gate without Space-admin oversight, unread and not set aside by
  them. Another member's reading or private items never change them.
- Interest evidence. A read counts toward the private interest profile only
  when the reader reached it themselves (`read_origin = 'library'`; an open
  from the digest's serendipity section is recorded `serendipity` and never
  counts, per B54). Explicit Library selection, saving for later or marking
  discussed upgrades an existing serendipity/project origin to library; ignored
  and pure dismissed changes do not assign an origin. Interest evidence also
  requires that the source is one they currently follow or own
  (`sourceItemProfileEvidenceClause`). Leaving a source rebuilds the profile's
  automatic facts (observations and candidate counts) on the next pass;
  topics the owner accepted or created, and dismissed candidates, stay.
- Item type views under All Items:
  - `/library/items/articles`
  - `/library/items/emails`
  - `/library/items/videos`
  - `/library/items/podcasts`
  - `/library/items/pdfs`
  These are soft read-time filters over source metadata, URL/domain hints, and
  MIME/content-type hints. They are not source import requirements and do not
  create hard schema categories.
- Reading recommendations (`/library/digests`): one deterministic cross-source
  selection per reader and complete day of the digest's configured timezone
  (see [information digest](information-digest.md#days-history-and-backfill))
  from subscribed channels with
  `digest_enabled=true`. Before selection, the automatic deterministic fact
  layer accounts for newly annotated items using this reader's private state;
  explicitly ignored items do not affect coverage or topic candidates. The
  cold branch ranks by recency plus source-diversity fairness; warming/warm
  profiles add explicit topic-match scores. Every persisted slot records its
  quota key, matched topic, component scores, and rationale.
  The private profile card lets the owner accept/dismiss recurring-phrase
  suggestions, directly create/edit/archive topics, configure maturity,
  ranking, decay, cooldown and probe parameters, apply optional idempotent
  starter packs, or explicitly queue a bounded annotation backfill. None is a
  prerequisite for cold-start delivery.
  A second, separately budgeted "Outside your usual view" section draws the
  configured number of items from the owner-private serendipity standby pool. Its first quota is
  reserved for a genuinely distant domain when one is available; remaining
  capacity prefers adjacent domains, with depth/genre inversion and a visible
  explanation. It never reads or writes implicit feedback into the interest
  profile.
  Each delivered serendipity item offers exactly one explicit response:
  Interesting (default 7-day cooldown), Neutral (default 30-day cooldown), or Never this
  direction again (permanent owner blocklist). Active cooldowns affect both
  standby delivery and weekly probe rotation. The permanent block also closes
  still-pending system Source recommendations for that direction, but never
  changes an accepted subscription.
  Annotation v2 also carries an objective normalized stance target and
  conclusion direction. When standby material contains the opposite direction
  on a target the reader has actually read, the remaining non-distant slot
  prefers it and explains the opposition; absent a real match, ordinary
  adjacent/exploration selection continues.
  Any personal digest item can be filed one-way into an active Project Corpus;
  the existing Project writer gate remains authoritative and the digest sends
  only the source-item reference plus provenance metadata for that action.
- Per-source run briefings remain below the daily selection and at
  `/library/digests/:connectionId/:date`; they are diagnostics/history for one
  processing rule, not the cross-source aggregation unit.
- Project digest (`/projects/:projectId/digest`): one shared snapshot per
  Project/day from Source items entering the Project Corpus that day. It uses
  Project triage/confidence rather than personal interests and has no
  serendipity quota. Each member's rendering joins their own
  `source_item_user_states`; private reading state is never copied into the
  shared digest.
  Item-level team reading counts render only at 3 or more active-member
  readers. If a Project has at least 3 active members, its digest may also list
  Project Corpus domains with zero active-member reads as anonymous team blind
  spots. Below that cohort threshold neither counts nor blind spots are
  returned.
- Both digest pages show the stored day as that calendar date beside its
  timezone (`Intl`, the reader's UI language only formats it), step to the
  previous or next day up to the latest complete one, and say whether the
  snapshot was scheduled or a backfill. A missing day shows the server's
  explanation and, for a complete day the reader may write, a "Backfill this
  day" action; viewing never generates. Stepping to another day keeps the page
  frame: the navigation moves to the day asked for at once, the earlier day
  stays dimmed and inert under a status line naming both days (backfill not
  offered), and it is replaced when the day lands. A day that cannot be read is
  named in an alert and no earlier content stays under it. On the personal page
  the daily edition lands, fails and retries on its own, without waiting for
  Source briefings, the profile or the Project list. Kept content is dropped on
  a scope change or logout. `/library/digests` also shows the
  reader's own Source annotation failure episodes (`AnnotationRecoveryNotice`):
  a relative and absolute next-retry time only while an automatic retry is
  scheduled, the waiting condition otherwise, and "Retry now".
- Single-item reader routes:
  - `/library/items/:itemId`
  - `/library/digests/:connectionId/:date/items/:itemId`

## Does Not Own

- Source connection configuration, scan schedules, or post-processing rules
  (`modules/sources.md`).
- Project-owned source bindings, project source item links, and binding health
  (`architecture/PROJECTS.md`), plus the Project collection query currently
  served at `/sources/project-items`.
- Source recommendation/subscription decisions (`modules/sources.md`).
- Activity Inbox notification lifecycle (`modules/activity-inbox.md`).
- Reader document resolution or annotation storage; Library supplies the
  source-specific wrapper around the shared Reader workspace.

## Flow

```
source_channel_user_subscriptions (subscribed + digest_enabled)
  + source_channel_item_links + source_item_annotations
  + owner-private interest profile when maturity != cold
  -> information_digests + information_digest_items
  -> GET /api/v1/spaces/:spaceId/information-digests/personal  (read-only; missing day → explicit backfill)
  -> /library/digests

weekly information_digest probe
  + code-owned domain gaps + Brave Source connector (configured hard budget; default 3 requests)
  + pending recommendations for existing space-shared Sources
  -> information_digest_serendipity_pool
  -> separate daily serendipity quota (no delivery-time network call)

explicit serendipity response
  -> information_digest_serendipity_feedback (one immutable response/item)
  -> information_digest_serendipity_domain_states (cooldown or manual block)
  -X interest_profiles / interest_topics / interest_profile_* facts

project_corpus_items created today + source_item_annotations
  -> one information_digests Project snapshot
  -> GET /api/v1/spaces/:spaceId/projects/:projectId/information-digests
  -> /projects/:projectId/digest

source_channel_user_subscriptions (subscribed + digest_enabled)
  + source_post_processing_runs/artifacts/decisions
  -> GET /api/v1/sources/briefings
  -> /library/digests
  -> /library/digests/:connectionId/:date detail
  -> /library/digests/.../items/:itemId reader

source_channel_user_subscriptions (subscribed + library_enabled)
  + source_items
  + source_item_user_states
  -> GET /api/v1/sources/items
  -> /library/items or /library/items/:type
  -> /library/items/:itemId reader

source item resolver + shared annotations
  -> GET /api/v1/reader/documents/source_item/:itemId
  -> /library/items/:itemId ReaderWorkspace
```

`GET /api/v1/sources/items` is Library-only. Project collection views use
`project_source_item_links` through the Project Sources collection read model and do
not imply that the current user follows the underlying source.

Activity Inbox points into Library through daily aggregate rows with
`activity_records.aggregate_key = source:briefing:<source_channel_id>:<date>`.
Those rows contain only counts and a short preview; full digest and item
content stay in the Library/Sources read model.

Per-source Briefing run summaries require at least one output artifact readable
by the viewer. A proposals-only or mark-only run with no output artifacts has
its summary withheld too: that model narrative is not a public status message.

Source recommendation inbox rows point back to Sources Pending. Reviewing or
archiving the Activity row only clears the notification pointer; Follow,
Dismiss, Mute, Leave and Follow again are stored in
`source_channel_user_subscriptions`.

Project source collection inbox rows point to `/projects/:projectId/sources`.
Reviewing or archiving those Activity rows clears only the notification pointer;
it does not mutate project source bindings or source subscriptions.

## Related Files

- `apps/web/src/modules/library/`
- `apps/web/src/components/reader/`
- `server/src/modules/reader/`
- `server/src/modules/informationDigest/`
- `server/src/modules/sources/postProcessing/`
- `server/migrations/0000_baseline.sql`

## Related Docs

- [information-digest.md](information-digest.md)
- [activity-inbox.md](activity-inbox.md)
- [sources.md](sources.md)

Project fixed-page monitoring changes open the existing Library item Reader.
They are evidence documents containing the previous/current captured body and
references to the two Sources page-version snapshots, not live refetches or new
articles. Their source_uri is intentionally null in the stored change item, so
re-extraction cannot overwrite the historical comparison with a live page.
The monitoring/Digest surface supplies the original page link separately.
Reader and snapshot access still recheck the Source/Project/current audience;
revisiting an old page revision never rewrites its comparison artifact.


The reading-first UI keeps recommendation preferences/annotation recovery and
individual Source processing briefings in separate collapsed sections. Primary
cards show the title, summary, rationale and reading/Project actions rather than
raw rank scores. The edition still belongs to the latest complete day, not an
invented live feed; Source settings owns subscription and collection management.
Opening Reading never activates acquisition or changes source visibility.

The unified reading backend contract is available separately from edition reads:
see [Information Digest — Unified reading projection](information-digest.md#unified-reading-projection).
It supplies cross-day pending/read lists for recommendations and material saved by followed goals, current authorized
Project reasons, personal opt-in and a searchable all-material view. Its item
and material references open the same shared Reader; callers forward
`reader_origin` as the Reader's `origin` query to preserve interest isolation.
The existing edition and per-Source routes retain their scope and history; explicit `?date=` opens that fixed edition, including completed members.

Followed-goal intake is eligible only through server-recorded goal membership
(`source_goal_items`, see [SOURCE_GOALS](../architecture/SOURCE_GOALS.md#goal--sourceitem-membership)),
never item metadata. `GET .../reading?topic=<goalId>&topic_selection=important|all`
restricts the same authorized, grouped list to one followed goal the viewer may
read (personal owner, or a live Project reader in that scope); an invisible topic
is 404. Each item carries `topics` (goal id, the topic's own `project_id` and
bounded `title`, selection status, reason, `judged_by`, `delivery_kind` —
baseline, new publication, evidenced change or unknown freshness — and the
latest `change_evidence_url`) for the visible goals of all its grouped members,
keeping the strongest selection.
`important` lists only topic-judged selections; `all` means every material the
goal actually collected, not complete coverage. Topic and selection belong to the
cursor scope, and topic visibility is part of the page fingerprint.

## Unified reading UI

`ReadingWorkspace` consumes the typed `informationDigestsApi.reading` contract
for both My reading and Project reading (`/projects/:projectId/sources`). Pending
is the default; read and all-material views change the server query, never a local
filter of one fetched page. Cards render all currently authorized contributions,
original rationales, edition date/timezone or first-result label, recommendation
arrival time and separate article time. Material-only rows are explicitly labeled. Successfully saved goal collections enter Pending without requiring a digest or annotation; preview-only results do not. Eligibility is established by the canonical successful collection audit and binding, with existing Source/Project access gates, personal Project opt-in, deduplication, and read/dismiss states preserved. Pausing a goal does not remove its saved reading history.
Summary-only rows do not link into Reader. Full rows forward `reader_origin`,
including project, to the shared Reader. A bounded return destination preserves
reading navigation; legacy day-scoped Reader deep links retain prev/next.

List controls: newest/oldest order is a server query (`sort=oldest` in the URL
and in `readingReturnTo`'s whitelist; `newest` is the default and never
written); comfortable/compact density is a browser preference
(`rainver:reading-density`, on the logout keep-list). Rows form a list with
↑/↓ (j/k), Home/End and Enter (opens the row's own Reader link). Rows show the
viewer's private reading progress. The search field says what it searches
(titles, summaries, sources — not full text) and is distinct from the Reader's
find in this document.

Opening an item keeps two per-tab records in sessionStorage (cleared on
logout; `readingSequence.ts`): the list as the server returned it (ids, keys,
access level, opaque next cursor, query) and where the list was left. Back on
the list within 30 minutes, it reloads up to as many rows as were open (≤150)
and focuses the item, or says it is no longer in the list. In the Reader,
`ReadingSequenceNav` offers previous/next in list order, skipping summary-only
rows, with first/last states. A row is named by its item and topic change
(the Reader's `change` parameter): the same item listed as material and again
per update is several rows, and neighbours, the return point and "mark read"
use that row. Past the loaded rows it follows the list's cursor with the same
query for at most 5 pages, skipping pages of summary-only rows; if rows remain
beyond that it says so rather than claiming the end. A reply is kept (in
storage or on screen), navigated on or announced only while the run that
asked is still mounted for that row and session (an owner token per mounted
row, dropped on unmount, so A→B→A cannot revive it), and a
refused cursor (the list changed) keeps the Reader where it is. "Mark read and next" (unread items without a
topic change, which has its own confirmation) calls the canonical reading
state API and moves only after it succeeds. A kept record grants nothing: the
Reader re-checks every document.

`useReading` owns request sequencing, scope resets and page transport only.
Space/Project/view/search are bound to each request and cursor; late responses
are discarded and superseded GET transports are aborted through the existing
RequestOptions.signal/fetch path. Search keeps an editable draft; only explicit
form submission updates the URL and issues the aggregate query. Errors clear displayed content (including stale authorization),
and a 409 offers a fresh first page. Mark read/restore/dismiss call the canonical
state API then re-read the already loaded window from the server. Existing
cards stay mounted and disabled until that authorized replacement is complete,
preserving native scroll anchoring. Each fetch is at most 100 items; larger
windows follow fresh server cursors before publishing atomically. Errors clear
the whole window, including partially fetched replacements. No browser
deduplication, local membership/count inference or second state store is added. Private dismissals can be restored in All material.

Project preferences are discoverable in both reading scopes. Per-project controls
read the authenticated user's default-off setting, wait for server confirmation,
and show failed writes without claiming success. They never change monitoring
scope, schedules, Source subscriptions or budgets. The personal preference picker
lists the first 200 active Projects and links to the Projects directory for more.

Daily editions remain at `/library/digests` and Project `?tab=digest`; each uses
explicit scope/date, clears old content on failures and ignores superseded reads
or backfills. Reading state remains dynamic without removing historical members.
The existing interest controls, annotation recovery and per-Source historical
briefing deep links remain available. Source management owns live candidates
and diagnostics; review links target the canonical pending proposals surface.

Home retains its user-level cross-Space work aggregate and adds only a three-item
preview of the preferred Space's same pending API. The preview names its scope,
links into Reading and performs no generation, ranking, aggregation or acquisition.
Summary-only preview entries are plain text rather than inaccessible Reader links.
Project candidate/source-management Reader links use the lightweight shared
readingLinks helper with project origin and bounded candidates/settings returns.

### Using Reading and finding retained material

1. Open Reading in the current Space. To read spans retained days; completing an
   item removes it from that queue, while Read and its original Daily edition
   retain it. Restore unread returns it to the queue. Private set-aside can be
   undone from All material.
2. Open Project reading preferences to include formal recommendations from a
   Project (default off). Each enabled Project contributes its original reasons;
   matching content has one card with all authorized reasons. Disabling a Project
   removes that contribution, retaining your own saves and other contributions.
3. Use All material for associated material that was not selected. Filing a
   personal edition item into a Project uses the existing Corpus-add writer;
   Project All material finds that SourceItem and opens the same retained Reader
   body, without copying it into another document.
4. Daily editions use explicit scope/date, display their original timezone, and
   do not generate on GET. A missing complete edition offers an explicit backfill
   only when allowed; its provenance explains retention limits. Initial results
   have no invented edition date. DST and delayed work use the original local
   period/slot, and existing snapshots remain frozen.

Research Reading List and shared Source annotation links also forward project
origin. Their bounded return targets are the research reading-list tab and Source
settings, respectively. Reader names those destinations accurately and preserves
origin when re-extraction reloads the document. Refresh, extraction and Inspector
controls follow the browser English/Chinese locale. The personal preference
picker shows its isolation explanation once, while a standalone Project control
keeps its own explanation.

Daily edition item links also use `readingHref`, preserving the snapshot's exact
scope and `digest_date`: personal `/library/digests?date=YYYY-MM-DD`, Project
`/projects/:projectId/sources?tab=digest&date=YYYY-MM-DD`. Project context is
explicit because the same SourceItem can be recommended by another Project.
Reader labels either destination Daily editions / 每日版 and returns to that day;
project/serendipity origins and old Source day prev/next are unchanged. Only exact
bounded destinations with valid calendar dates pass `readingReturnTo`; query
extensions, encoded/normalized path tricks and mismatched Projects are rejected.

Project Settings also links to the existing Source management configuration via
`/projects/:id/sources?tab=settings&from=settings`. Its visible arrow-back control
returns to the same Project Settings dialog (`?settings=project`); other entry
paths return to Project reading. Switching management tabs preserves this bounded
origin. The Reading entry remains available; no monitoring form or authority is copied.
With unsaved Name, Description or Current focus edits, the link asks before
leaving: Keep editing preserves the open draft, and only Discard navigates. It
never saves those shared fields itself and is inactive while a save is in flight.

### Reading presentation

Personal and Project reading use the system page gutters and compact icon/title
header, with a theme-colored divider. Reading filters form a separate group from
edition, source-management and review links. Recommendation, candidate and edition
cards use a single-column list, compact titles, shared status badges and neutral
rationale borders. Empty/loading lists reuse EmptyState and Skeleton.

Daily edition feedback and Project filing reuse Button and Select; Project editions
use the same reading presentation as personal editions. Reading preferences follow
the shared card/form styling, and interest controls use the English/Chinese locale
catalogs. Reader toolbar controls use the shared small icon size and explicit
border tokens; long-form document typography remains specific to Reader.

The Library Reader wrapper shows a short title in its toolbar and passes the full
title plus source metadata (Agent-provided label, document type/content state,
source host) as the Reader lead above the body. The document loads on its own
and the annotation list through the shared `useReaderAnnotations`: a missing
document, a 403 (no retry offered) and a failed load (retry) are distinct
states; an inaccessible document also drops its unsent comment drafts; an
annotation-list failure keeps the text readable with a local retry. Project
Research reports follow the same contract (see the Reader guide). Reading list links carry the submitted search
`q` in their bounded return path, so Reader returns to the same results.

### First reading material

An empty unfiltered To read or All material view offers “What would you like to
keep following?” in EN/ZH. “Follow a topic” opens the shared topic creation page
with optional Project context; it creates nothing until the topic, frequency and
effort are confirmed once, after which preparation and the first collection run
in the background (see [Topic reading journey](../architecture/SOURCE_GOALS.md#topic-reading-journey-ui)).
Topic pages recover their update stream, status and plan on return/refresh.

Save an article still uses the existing URL writer and extraction jobs, with
Project writer checks. Only a completed save revalidates the Reading list;
cancelling either save or unsent setup leaves the list mounted. Reader,
subscriptions and successful SourceItem history remain the same consumers.

Project Sources/configuration now opens the same goal management list. Historical
monitoring candidates/digests, linked Source display and necessary settings remain
reachable through their existing routes. Compatibility mapping sends no collection
requests and keeps the old scheduler owner until following is confirmed; then
the topic is the Source's only automatic scheduler and a manual Project
monitoring run of that Source is refused. See [SOURCE_GOALS](../architecture/SOURCE_GOALS.md) for transfer and
conservative rollback semantics; engine output is not itself a Library item.

Reading goal setup and management stay under `/library/reading/goals` for
personal Reading, and `/projects/:projectId/sources/goals` inside the Project
layout. Both reuse the Sources-owned goal components and backend API. Return,
creation recovery and stop navigation retain this context; there are no legacy
Sources goal route aliases. Settings and return actions use the shared Button
component rather than standalone underlined action links.

Reading lists this scope's topics (`useScopeTopics`, refreshed while one is
preparing or collecting) in a topic filter beside the views. Choosing a topic
queries the server with `topic` and `topic_selection` (`important` by default,
All as a toggle); the URL keeps `topic`/`topic_selection` with the view, and an
empty filtered list shows a topic-specific empty state rather than first-use
guidance. Cards show each visible topic link (topic title linking to its page,
freshness, judgment, reason and who judged). Reader links from a filtered or
non-default view return to that exact list (`readingHrefReturning`);
`readingReturnTo` accepts only the Reading/Project-reading list with known
`view`/`topic`/`topic_selection` values and topic pages with `selection`, each
key once, canonically encoded. Opening a topic never starts an Agent Run.
Model/mode controls use the common conversation configuration component and only
the selected runtime's advertised choices.

Agent-assisted search links carry `agent_provided_unverified` provenance on Reading
cards and Reader details (EN/ZH). The public Reading/Reader DTO projects only this
status from metadata, not raw Source metadata or content. Metadata-only Agent links
open with an empty body and their original link; no summary or verification is invented.

Reading places Following alongside Source management in the same tools row,
with a badge counting confirmed following in the current personal/Project scope
(`follow_state.intent === 'following'`, including background preparation).
Manual-save-only, unconfirmed and paused topics remain in management but do not
inflate the badge. There
is no separate top goal banner. The management page has a scoped Back to reading
link at the top and grouped controls with shared spacing. Goal titles and deletion
confirmation belong in that list and detail; collected material is retained.
The plan conversation (topic Advanced section) links only the latest search Run's
execution details; collection progress is not repeated in the chat.

### Preparing saved material

`MaterialProcessingPanel` is the one reading preparation control used by Reader
and `SaveReadingUrlDialog`. It observes Sources' persisted operation and Run, not
a browser-run extraction job. A saved link, repository and new query share the
[Sources material contract](../architecture/SOURCE_MATERIAL_PROCESSING.md).
The Library list opens Reader rather than keeping a second extraction/retry flow.

Material preparation uses shared status badges, buttons and theme tokens in both
Reader and URL saving. The parent owns outer spacing; goal execution settings
reuse the same picker without nested frames. Reader itself offers no Agent picker;
material preparation inherits the saved goal or existing owned default configuration. Queued/working/final updates are
announced through the status region, and failures retain the standard error color.

Saving a link starts its preparation before the dialog mounts the panel, so the
panel's first read sees the queued operation rather than an idle state. If
preparation fails after the owner allowed a Source's readable content (for
example a missing model-egress permission), the consent dialog closes and the
refusal is shown; nothing is queued. Real-backend acceptance
(`readingBrowserAcceptance.browser.ts`, EN/ZH) covers Read again without an
execution configuration, consent decline and acceptance through the real
proposal, the separate egress refusal, a queued Run with its execution link,
cancellation, and a fixture Agent submission that becomes the Reader body.

## Topic change deliveries

Reading may contain both an existing material and separate immutable topic-change
deliveries for it. `ReadingItem.topic_change` and the `change` Reader query carry
the exact delivery identity; `topic_change_id` in the existing Reading state API
confirms or dismisses that change for this viewer only. These rows sort by their
new delivery time and use the same pagination/access reload contract. A repeated
evidence URL does not create a delivery, and confirming an older change leaves a
newer change pending. Material read state, highlights, annotations and body
revision remain intact. Topic update rows show a localized badge and the cited
evidence through the existing topic summary. Actual SourceItem full-content and
Source/Project consent gates apply to derived evidence; summary-only materials
do not expose change reasons/evidence. Topic material/change totals describe the
viewer's currently visible set, not hidden historical inventory.

Reading, topic updates, daily editions and legacy type lists share `ReadingCard`:
two-line title and summary, quiet metadata and compact topic links, with actions
on the right from `sm` and a wrapping action row on narrow screens. Expanding
“Why this is here” reveals the full summary and original recommendation,
judgment and material associations. Agent-provided/unverified provenance stays
visible. Topic titles prefer the planning Agent's short label; old topics retain
the original subject as a fallback and truncate visually.

### Reading list preview and state undo

A Reading container at least 980px wide shows a preview beside its rows. Row
focus/keyboard movement or the Preview action chooses the current list item's
summary, recommendation rationale, topic links and source address. It makes no
parallel document request. The preview reads only the current authorized page,
clears on query/revalidation failure, and offers a Reader link only for `full`
items. Narrow containers retain direct title navigation with no extra step.

A confirmed read/unread state update offers toast Undo through the same Reading
state endpoint, restoring the original state and re-reading the server list.
A failed update offers no success action. The action belongs to its mounted
view generation and session epoch; a switch away and back cannot revive an old
Undo, and repeated activation cannot send the same restore twice.

Reading 个人状态反馈统一覆盖已读和放一边/恢复：确认后提供撤销，
撤销使用原状态及 topic change 身份。所有旧 toast 与当前按钮共享同步写入互斥；
撤销按钮按 Sonner 合同保留到服务端恢复成功，失败/忙时保留重试，亦可手动关闭。


Reader document notes are independent Notes, created only after confirmation and
resolved into the person's Personal Space by the access-owned creation context.
Reader stores a private typed document→Note association, never a second body or
an empty quote annotation. The Notes editor owns content/revisions/sharing. Both
current document and Note access gate each resolution; cross-Space links use the
Note's actual Space. Repeated create reconciles one association and note.

Reading-list article swiping is opt-in and browser-local. Only ordinary top-level
prose recognizes short horizontal touch; tables, code, images, selections and long
presses keep native interaction. Navigation reuses the existing neighbour/cursor
sequence, skips summary-only entries and never writes read state. Session/scope
changes and cancellation invalidate the gesture; buttons remain available.


Reading's main list and Following details use the same `ReadingStatusBadge`.
For an unread material in the latest finished collection of a visible topic,
it replaces the existing unread badge with Just collected / 本次新增; it does
not add a badge or row. Skimmed/read states and independent change deliveries
keep their existing status. Topic-filtered lists use only that topic's arrival
flag; the unfiltered list accepts an arrival from any currently visible topic.
The Reading query derives eligible goals with the same scope/Project read rules
as its topic links before loading latest audits, and retains material plus
collecting-Source authorization. This is not publication age or since-last-visit
state. No read acknowledgement is written by displaying it. See Source Goals'
latest-collection contract for provenance and failure/empty-check semantics.

## Reading method improvement

Reading and digest cards and the Source Reader have a server-authorized **Improve
this result** entry to the existing `/prompts` workspace. It verifies the material,
Project and (for Reader) canonical shown artifact, then shows the actual effective
method and recorded result provenance; historical unknowns are not guessed. Only
existing asset maintainers can edit/trial/request activation. The simple workspace
retains the advanced prompt page via a disclosure, without a new top-level nav.
See [Reading methods](../architecture/READING_METHODS.md) for version freezing,
private paired Runs, human judgment, proposals, rollback and verification limits.

The Reading method workspace leads with a description-driven candidate generation
using an explicitly selected owned execution configuration; manual editing remains
in an advanced disclosure. Generation only saves a draft: the existing explicit
comparison and human approval path still controls activation. Logs are not inputs.
