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
  sections; defaults to `/library/items`.
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
  counts, per B54) and the source is one they currently follow or own
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
- Library daily digest (`/library/digests`): one deterministic cross-source
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
  day" action; viewing never generates. `/library/digests` also shows the
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
