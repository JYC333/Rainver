# Module: Information Digest

## Status

Implemented. `server/src/modules/informationDigest/` owns the persisted daily
personal and Project information digests, interest-profile HTTP surface, and
the system-managed Automation target. Source annotation and the private
interest-profile fact model remain separate support packages.

## Ownership and routes

- `GET /api/v1/spaces/:spaceId/information-digests/personal[?date=]` reads the
  owner-private snapshot of one day. It never generates: a day without a
  snapshot answers `{status: "missing", …}` with the day's timezone, interval,
  whether a backfill is possible, and an explanation. Without `date` it reads
  the latest complete day of the digest's timezone.
- `GET /api/v1/spaces/:spaceId/projects/:projectId/information-digests[?date=]`
  reads the shared Project snapshot of one day the same way, hydrated with only
  the current reader's private state.
- `POST /api/v1/spaces/:spaceId/information-digests/personal/backfill` and
  `POST /api/v1/spaces/:spaceId/projects/:projectId/information-digests/backfill`
  (`{date}`, protocol `InformationDigestBackfillRequestSchema`) build a missing
  complete day explicitly. Personal backfill is the owner's own; Project
  backfill requires Project read and write. `201` answers a new snapshot, `200`
  an existing one; a day still in progress answers `422
  digest_day_not_complete`.
- Snapshots are made by the hidden daily `information_digest` Automation of
  each scope, or by an explicit backfill. Nothing else writes them.
- `/api/v1/spaces/:spaceId/interest-profile*` is the authenticated owner-only
  surface for the profile snapshot, settings, topic candidate decisions,
  direct topic create/edit/archive, optional starter packs, and explicit
  bounded history backfill (the most recent subscribed items first).
- The digest-item route owns explicit serendipity feedback. Filing an item into
  an active Project Corpus is not a digest route: the Library page calls the
  existing Project corpus-add route (`metadata_json.origin =
  'information_digest'`), so the Project writer gate applies.

## Personal pipeline

The daily transaction takes a scope/day advisory lock, returns the day's
snapshot when one exists, and otherwise runs the deterministic interest-profile fact layer before selecting. The
fact layer consumes successful shared annotations of the items this reader
may read (the Source item content gate; another member's private item never
counts toward this reader's candidates) joined to this reader's private state.
Read material contributes recency-weighted domain coverage and
recurring topic phrases only when the read is interest evidence: the reader
reached it themselves (not through the serendipity section,
`source_item_user_states.read_origin`) and still follows or owns its source
(`modules/library.md`, "Interest evidence"); items explicitly marked
`ignored` contribute neither coverage nor topic candidates. Leaving a source
resets the derived facts so the next pass rebuilds them from current sources. An observation ledger makes repeated passes
idempotent.

Fine-grained topics are owner data. Recurring normalized phrases become
deterministic candidates after configurable occurrence/read thresholds; no
model call invents or activates a topic. Only owner acceptance or direct owner
creation activates one. Do not let an Agent activate a topic.

Profile maturity is explicit (`cold`, `warming`, `warm`). Cold readers still
receive a digest using recency and source-diversity fairness. The profile is
maintained automatically even in the cold branch; cold means insufficient
evidence, not an absent row. `interest_profiles.settings_json` configures
coverage decay, maturity and candidate thresholds, interest/serendipity slot
counts, cooldowns, and weekly probe budget. Defaults and validation live in
`interestProfile/settings.ts`.

Starter packs are optional and idempotent: they add only missing topics and
feed existing shared-source suggestions through the normal pending
subscription decision state machine. They never rewrite an existing topic or
require a matching source. Historical annotation is also opt-in; the route
queues at most the requested bounded number of subscribed items without an
annotation row, then wakes the existing annotation job. Failed rows follow the
annotation retry policy in [sources](sources.md#annotation-failure-and-recovery)
instead of being silently reset.

## Days, history and backfill

A digest covers one complete calendar day of its scope's configured timezone:
the `timezone` of the scope's daily `information_digest` Automation
(`config_json.timezone`, an IANA name; `UTC` when absent). The day is the
half-open UTC interval `[period_start_utc, period_end_utc)` computed with
`Intl` (`digestPeriod`), so a DST day is 23 or 25 hours and every instant
belongs to exactly one day. Where the clock jumps forward at midnight
(America/Santiago, America/Havana) the day starts at the end of the gap, the
first instant whose local date is that day. Candidates are chosen by that interval.

A scheduled pass reports the local day before its schedule slot, decided from
the slot the Automation was due at (`next_run_at`), not from when a worker gets
to it: a fire delayed past midnight, or replayed after a restart, still names
the slot's day and finds the same snapshot. The reader's UI language and
timezone never change which day a snapshot is; the UI labels the stored date
with the stored timezone.

Every snapshot persists `digest_date`, `timezone`, `period_start_utc`,
`period_end_utc`, `generation_kind` (`scheduled` or `backfill`) and
`generated_at`, and is write-once: one row per scope, owner and day, never
rewritten. Concurrent passes for the same day serialize on the scope/day lock;
one creates and the others return it.

A backfill is only for a complete day and is idempotent per scope, owner and
day. It uses only the material retained now, reports that in
`settings.history_note` and the `backfill` kind with its real `generated_at`,
and never spends the serendipity standby pool, so its serendipity section is
empty. A failed backfill writes nothing and can be requested again.

## Serendipity

Weekly personal probe Automations rotate through uncovered code-owned domains
with the configured hard request budget. Existing shared-source suggestions
and optional credentialed Brave results fill an owner-private standby pool.
Daily delivery performs no external call and uses a separately configured
quota, reserving a distant slot when possible and otherwise applying adjacent,
depth/genre, and same-target opposing-stance preferences.

Each delivered item accepts one explicit `interesting`, `neutral`, or `never`
response. The first two set configured domain cooldowns; `never` creates the
owner's permanent domain block and closes only still-pending source
recommendations. This state never changes interest-profile facts or topics
(B54).

## Project pipeline and privacy

Project selection reads annotated Source items entering the Project Corpus
during the digest day's interval and ranks by Project triage/confidence, not personal interests. It
has no serendipity quota. Raw member reading state never enters the shared
snapshot. Item read counts require at least three readers, and zero-reader
domain blind spots require at least three active Project members (B56).

Digest Source reads use the canonical SourceItem ACL and connection-consent
gate. Personal snapshots preserve summary-only access by withholding full
fields such as excerpts and Source URLs. A shared Project snapshot admits a
Source item only when every current Project reader has full access without
relying on Space oversight; hydration rechecks the current reader so revoked
consent or later membership changes fail closed.

## Briefings (shared kernel; Project scope)

`briefing/` synthesizes one evidence-backed briefing across a scope's sources.
It is separate from the per-channel `batch_digest` and from monitoring limits,
which stay as they are. Plan: `.agent/plans/shared-briefing-and-project-loop.md` §9.

- **Kernel and adapters.** `contract.ts` defines `BriefingScopeAdapter`
  (scope, audience, `canRead`/`canGenerate`, candidates, context,
  `allowedItems`, `signalState`, `contextState`). `projectScope.ts` reads
  Project Following goal items, Project monitoring decisions and the active
  Corpus, plus the active brief version and at most 8 open Tasks. Every item
  and Task must be fully readable by every current Project reader
  (`everyReader` + `sourceItemFullContentReadClause`/`goalCollectionReadableSql`/content
  access), so no member's private reading enters. Each scope signal carries
  its collecting Source (Following binding, decision channel, Corpus entry).
  `personalScope.ts` is the reader's own briefing in one Space; its audience
  is the owner alone. It draws on what their Reading already uses:
  - their personal Following;
  - items their subscribed channels delivered (lens `subscription`; an
    existing annotation makes them ready);
  - the Following, deliverable monitoring and Corpus of each Project they opted
    into Reading (`ReadingPreferences`) and may still read. Project lenses are
    labelled `Project "<name>": …`; a readable Project is never included
    without that opt-in.

  It reads nothing about other members, and no other Space. Its only context
  is their own Following topics (`personal_focus`, goal sources), so cold
  start works; Memory and the interest profile are neither read nor written.
  `signalState` admits a Project-derived signal only while that Project is
  still opted in and readable. Opting out, losing access or deleting the
  Project therefore withdraws, through the one authorization rule, every
  version and later comparison resting on it, at dispatch, publication and
  read.
- **Dependencies.** Every text that can reach the model is a dependency with a
  revision and a Source connection: each family member item
  (`content_hash:body_revision`), its annotation (hash of the summary, so an
  in-place rewrite is a new revision), and each scope signal (hash of label
  and text). They are frozen in `information_briefing_inputs.analysis_json.deps`.
  `authorization.ts` is the one rule used before dispatch, at publication and
  on every read. A ref stands only while every dependency is readable by the
  whole current audience. Each annotation and scope signal is also gated on
  its own collecting Source (`readableCollecting`: the canonical Source reader
  gate plus full `source_connection` access, without oversight), at
  preparation and in that same rule; a readable item never carries an analysis
  or reason from a Source the audience cannot read. At dispatch, every
  connection behind it must also still consent to the Run's model, and every
  revision must be unchanged. `everyReader` treats a clause that evaluates to
  NULL for a member as "may not read".
- **Manifest.** `manifest.ts` freezes one version:
  - Families merge by `readingFamilySql`: one capture, not one event. Different
    URLs about one event stay separate inputs, and the model groups them.
  - A member, annotation or signal whose own Source refuses the model
    contributes nothing.
  - Delta classes: `baseline`, `new_publication`, `newly_found`, `revised`
    (body or analysis revision), `evidenced_change`, `unknown_time`, and
    `background` (comparison material that is never news).
  - Pending inputs are carried to the next version: not analysed, truncated,
    egress-refused, and not shared with the whole audience (bounded at 200).
  - The candidate window includes body and analysis changes of in-scope items,
    so a revision is found without new membership activity.
  - The previous published version's still-readable highlights, and their
    material re-gated now, are sent as `<previous_briefing>` plus `background`
    inputs. Each comparison text is frozen in `comparison_json` with its full
    dependency closure: the dependencies of every S it cited there, the context
    source of every C it cited (a done Task still shared with the Project is a
    valid one), and the closure that version inherited, so it is transitive
    across generations. If anything in a version's closure no longer stands,
    nothing of that version stands: dispatch is refused, publication fails, and
    reads withhold it. They are sent only when there is news, or when the Project context
    changed: then impact is reassessed and the version is marked
    `context_changed`. Overview prose is never replayed.
  - The whole request (prompt + instruction) is held to 48,000 characters:
    blocks are shortened over three levels, then the lowest-priority inputs are
    truncated (and carried), and the total is asserted before the Run exists.
- **Storage.** `information_briefings` holds versions per `scope_key`:
  - one queued version per scope and a unique `request_key`;
  - one live (queued/ready/blocked) version per sealed `period_date`, with
    failed or cancelled days kept as history beside their replacement;
  - `request_hash` of the exact frozen request, and a `checked_at` bookkeeping
    time;
  - a day's `(digest_id, space_id)` reference to its sealed digest uses NO
    ACTION. A referenced digest is not deleted on its own (SET NULL would also
    null the tenant column), and deleting the Project removes both through
    their Project cascades.

  `information_briefing_inputs` holds the frozen refs, revisions, delta classes
  and dependencies. Migration `0007_information_briefings` is unpublished and
  regenerated.
- **Versions and reuse.** The comparison chain runs through the latest
  published version only. The request key is the substantive state: the
  published predecessor, input and context hashes, protocol and execution.
  - The same state returns the same version. A "nothing new" check is reused
    (`checked_at` is updated) instead of piling up empty versions, and the
    overview keeps the last published briefing readable as `latest_briefing`.
  - A failed version is retried only with its exact frozen request, read back
    from its last Run and verified by `request_hash`. Otherwise it is
    `409 briefing_version_stale`.
  - Changed state is a new version.
- **Execution.** `service.ts` locks the scope, reuses as above, and writes
  `no_material`/`no_new_material` without a Run. Otherwise it creates a
  canonical private Run (`createQueuedRunWithBudgetAdmission`) on the
  requester's own usable Agent and profile:
  - no tools, `max_attempts 1`, 900 s;
  - scheduled runs also count against the Automation budget;
  - managed policy `information_briefing` is fail-fast for both `manual` and
    `job`; only `job` carries the credential pre-authorization.

  The Run gets its own Work Context setup (scope = the Run) with retrieval off
  and nothing pinned, so no requester Memory, Library or private material
  joins a shared result. Then the attempt is CAS-started and `agent_run` is
  enqueued. Limits: 40 news inputs + 12 background families, 3 attempts per
  version, 6 Runs per scope per day. There is no token or currency cap during
  a Run.
- **Dispatch and settlement.** `orchestrationService` calls
  `assertBriefingDispatch` at three points: before running, after runtime
  preparation, and before the adapter. Each call checks:
  - the current attempt and its `request_hash`;
  - that the requester can still write;
  - the closed Work Context (`briefing_context_widened`);
  - the dependency authorization with egress (`briefing_access_changed`);
  - unchanged revisions and context (`briefing_inputs_changed`).

  A refusal is a `RunPreparationError` with that code. The Supervisor's
  managed fail-fast rule leaves the Run terminal, never `waiting_for_review`,
  and the reconciler `information_briefing` (canonical `runSettlement`,
  replayed by recovery) fails the version, releasing the scope. Settlement
  settles only the current attempt and validates the output against the
  manifest:
  - refs exist; facts cite material; `affects` needs context;
  - `new` must cite new inputs, and `update` must cite revised or
    evidenced-change inputs;
  - background supports `ongoing` only.

  It also refuses publication when the overview's dependencies are no longer
  readable.
- **Reads.** `projection.ts` re-authorizes on every GET (which never
  generates). An overview whose dependencies are not readable withholds the
  whole briefing; other dependent units are hidden and counted. Outdated
  Project context is flagged. `source_domains` counts distinct domains, not
  independent confirmation.
- **Held sealed days.** A sealed day that cannot start now is held: a
  `blocked` day row with its reason, its own date and cut-off, and its
  deferred request (`request_json`: origin, Automation, execution, label).
  Reasons are another version of the scope in flight
  (`briefing_scope_busy`), an earlier day still held
  (`briefing_earlier_day_pending`), or a blocking refusal. The in-flight
  version is never taken as that day's result. Held days start earliest
  first: when a version of the scope settles (the briefing projection calls
  `resumeHeldDays` after its own transaction), on the next daily fire, or on
  an explicit `POST {date}`. A day is held only if it passes the history
  rule at that moment: no version of the scope, published or in flight, may
  have a later cut-off, with the in-flight version excepted because it is
  only a temporary wait. The blocking-refusal hold path makes the same check.
  An out-of-order backfill is therefore `422 briefing_history_before_latest`
  whether the scope is idle or busy, and leaves nothing to resume. Once held,
  a day is ordered only against later sealed days, so a manual version
  published while it waits cannot strand it. One Run per scope still holds.
- **Panel progress.** `ProjectBriefingPanel` re-reads every 4 s while
  anything is still moving on the server: a queued version, or a day held as
  `briefing_scope_busy`/`briefing_earlier_day_pending`, whether it is the
  latest, the selected one or in history. Re-reads are GET only: one at a
  time, re-armed after each read lands, and capped at 30 minutes per mount or
  manual refresh. A selected earlier version updates in place. Refusals that
  need a person (quota, setup) do not poll. Everyone has a read-only Refresh,
  and Generate stays disabled while any version is in flight.
- **Routes.** `routes.ts` registers one set of handlers per scope:
  - `…/projects/:projectId/information-briefings`: reads need Project read
    access; POST, cancel and settings need write access;
  - `/api/v1/spaces/:spaceId/information-briefings/personal`: always the
    caller's own briefing.

  Each has `GET`, `GET /:briefingId`, `POST` (`{date}` briefs a sealed digest
  day of that scope: `422 briefing_day_not_sealed`, days in order),
  `POST /:briefingId/cancel` and `PUT /settings`. Daily briefings ride on the
  scope's existing digest Automation (`config_json.briefing`): the Project's,
  run as the enabling writer, or the reader's personal one, run as its owner
  only. A day that cannot start is held as above.
- **Web.** Under `apps/web/src/modules/library/briefing/`:
  - `BriefingView.tsx`: the shared display; impact and context labels follow
    `scope_type`;
  - `BriefingPanel.tsx`: the shared state, bounded polling, guards, status
    and history, with a `collapsible` mode;
  - `PersonalBriefingPanel.tsx`: at the top of personal Reading, collapsed;
    evidence opens the Reader and returns to `/library/reading`.

  `apps/web/src/modules/projects/ProjectBriefingPanel.tsx` binds the panel to
  a Project in its Sources digest tab.
- **Not yet built.** Notifications, Room follow-up and Task adoption (P3).
  Output quality with real models (event grouping,
  contradiction handling, false merges) and real instances are unverified.
  A synthetic published Project Instruction was checked with the production
  planner in two setups: the briefing Run's closed setup, and a legitimately
  re-bound Project setup with retrieval off and no pins. It was not injected
  in either; other policies or explicit controls were not tested.

## Related files

- `server/src/modules/informationDigest/`
- `server/src/modules/interestProfile/`
- `server/src/modules/sourceAnnotation/`
- `apps/web/src/modules/library/InformationDigestView.tsx`
- `apps/web/src/modules/library/InterestProfileControls.tsx`
- `apps/web/src/modules/projects/ProjectDigestPage.tsx`
- `server/test/informationDigestDb.test.ts`
- `server/test/informationBriefingDb.test.ts`, `informationBriefingAccessDb.test.ts`, `informationBriefingDependencyDb.test.ts`, `informationBriefingPersonalDb.test.ts` (fixture `server/test/support/briefingFixture.ts`)
- `apps/web/src/modules/projects/ProjectBriefingPanel.tsx`
- `server/test/interestProfileDb.test.ts`

## Related docs

- [library.md](library.md)
- [sources.md](sources.md)
- [automations.md](automations.md)
- [../architecture/PROJECTS.md](../architecture/PROJECTS.md)
- [../BOUNDARIES.md](../BOUNDARIES.md) — B54/B55/B56

## Confirmed Project monitoring (P2)

A Project with an active monitoring version uses the Sources-owned
`monitoring/delivery.ts` selector. Initial sealing and every Project Digest date
first take `monitoring-delivery:<space>:<project>`, then Digest takes its existing
scope/day lock. Selection and writing occur inside that transaction, with no IO.
The selector excludes both sealed initial membership and all Project Digest
membership, uses all current Project readers' full Source access, excludes shared
Corpus triage exclusions and dismissed decisions, and preserves private feedback.

Candidates must have a successful objective annotation and scoped relevance
decision. The decision's post-processing Run joins its actual monitoring
operation/version; changing presentation configuration cannot relabel an old Run.
`ready_at = greatest(project Source link creation, annotation time, decision update)`
must precede the complete day's end. Ready backlog is eligible regardless of the
old material's publication/Corpus date; this admits late annotation on a later
day. Current-day ready items rank ahead of older ready backlog. Preview reads and
`check`/daily operations do not reserve recommendation membership.

`information_digest_items.provenance_json` freezes bounded summary, evidence
depth, actual version/hash, decision/Run references and ready time; membership,
order and rationale are already immutable item rows. Hydration uses the frozen
summary and rechecks the complete current Project audience, not just the viewer.
Monitoring snapshots suppress team aggregates rather than exposing stale counts
about newly inaccessible rows. Older Project and personal snapshots retain their
original selection, hydration and history semantics.

An existing date remains idempotent. Missing monitoring dates may only be built
later than the latest sealed Project date. A backward request returns 422
`monitoring_history_before_latest`; lookup disables that backfill and explains it.
A stale scheduled slot is audited as skipped and advanced, never backfilled behind
newer snapshots. Generation still performs no Source/model calls and never waits
for all pages/analysis. Frozen coarse coverage distinguishes not_run, no_new,
analysis_pending, quota_paused, partial coverage and source failure.

The accepted monitoring schedule coordinates the existing single hidden Project
Digest Automation. `monitoringSchedule.ts` uses the provisioning scope lock,
refuses another owner's row or ambiguous duplicates, and changes only the accepted
owner's cadence/timezone and resumes that same owner's paused daily row when
the accepted configuration explicitly enables daily delivery. It never creates a second concurrent daily Digest.
Manual initial results remain separate from complete-day snapshots, and GET
never generates either.

Monitoring coverage belongs to the snapshot's local period. Generation selects
operations created in `[period_start, period_end)`, preferring a daily operation
whose frozen local_date and scheduled slot also belong to that period, then the
latest manual/check operation in the interval. Earlier quota/no-new outcomes and
future operations do not stand in for a missing day: no match freezes `not_run`.
A settlement after the day cutoff is represented as analysis pending, not copied
back as a completed historical state. Matching operations supply their frozen
configuration version and recommendation limit; with no run, the current confirmed
configuration only supplies selection settings. Existing snapshots never change.

## Unified reading projection

`ReadingService` / `ReadingRepository` own the read-only, Space-local reading
projection. `GET /api/v1/spaces/:spaceId/reading` accepts `view=pending|read|all`,
`limit` (1–100, default 30), optional `q`, `sort=newest|oldest` (default
newest; part of the cursor, so a cursor of the other order is refused with 422;
cursors issued before sorting read as newest) and an opaque `cursor`. Each item
carries the viewer's own `reading_progress` ({current, furthest} or null) from
their private Reader position (see [Reader](../architecture/READER.md)); it is
never read state. The same path
under `/projects/:projectId/reading` scopes it to a readable Project without
requiring the personal opt-in. Neither GET generates, fetches, ranks, writes a
snapshot or runs a model. `pending` is the default: unread/skimmed recommendations
across all retained days, excluding personal dismissals. `read` includes
read/discussed recommendations. `all` adds personal Library material, or the
Project's legitimately associated Source material, with no age cutoff.

The personal projection includes only the caller's persisted daily slots and
formal daily/initial Project recommendations from Projects they opted into.
Initial membership is the completed monitoring Operation's sealed
`recommendation_ids` plus saved `recommendations`, never relevance candidates.
All Project contributions recheck the viewer and complete current Project
audience. Withdrawing membership, Source consent or a preference removes that
contribution's name, reason and count; another authorized contribution survives.
Summary-only personal delivery withholds Source URLs. Each contribution retains
its original position, section, reason, frozen summary when available, edition
date/timezone (null for initial delivery), and actual availability time.
`occurred_at` remains article time. Existing edition routes/snapshots are unchanged.

All eligible deliveries are authorized before grouping, filtering and keyset
pagination. Source members and private state are joined in bulk; summary, search
matches, reasons and material references aggregate once per group, without a
per-group Space scan or correlated scan of the authorized CTE. Search reuses
`escapeLikePattern` with an explicit SQL escape character, so percent,
underscore and backslash match literally. A group sorts by its first eligible delivery time plus its stable
Sources revision key; an additional recommendation adds a reason without moving
or duplicating it. A cursor binds the Space, caller, view, search and Project,
and freezes delivery arrival time. New arrivals appear on a fresh read. A changed
permission/preference/content-membership fingerprint returns 409 and requires
restarting pagination, rather than using stale authorization or a shifted group.
Counts are computed only after current authorization and grouping.

`GET/PUT .../projects/:projectId/reading-preference` reads/sets
`{show_in_my_reading:boolean}`. The typed `reading.projects` ScopedSettingsStore
descriptor uses `space_user`, defaults off, and serializes concurrent edits with
a transaction lock. A Project viewer can change only their own preference; it
never mutates shared monitoring configuration, subscriptions or schedules.

`PATCH .../reading/items/:itemId/state` accepts `read_status` and/or `dismissed`
and returns `{updated}`. Sources resolves the current authorized equivalent
revision members and writes their private state atomically through `SourceItemUserStateStore`. No caller-supplied member list is accepted. Opening Reader remains
skimmed, not completed. Explicit read/restore actions outrank later incidental
opens on a new duplicate; only a changed retained body revision invalidates completion.
Metadata/raw hash changes and the first extracted body do not invalidate it.
Dismissal changes only `progress_json.reading_dismissed`, without changing
Library triage, Project relevance or interest feedback. The authenticated context resolves the anchor's origin: personal interest
recommendation/Library material is `library`, a personal serendipity slot is
`serendipity`, and a Project context is `project`. Copied members have no new
interest evidence and retain existing origins, including NULL. A non-reading
change leaves a new origin NULL. The Project-scoped state path is
`PATCH .../projects/:projectId/reading/items/:itemId/state`, with the same strict
request schema and current Project gate; the client cannot supply an origin. Digest maturity uses the Interest Profile service’s canonical
evidence inputs; Project-origin state is also excluded from exploration reading
shape. Cards expose `reader_origin` for the Reader request.

The protocol schemas are in `packages/protocol/src/reading.ts`; typed client
methods live alongside `informationDigestsApi`. The shared `ReadingWorkspace` and bounded Home preview consume this contract;
UI pages do not reproduce grouping, permission, pagination or state semantics.
Edition reads remain separate fixed scope/date history.

### Reading workflow verification

Cross-scope acceptance uses `readingDb.test.ts` with real PostgreSQL and the
explicit `readingBrowserAcceptance.browser.ts` Chromium harness. It covers
personal + Project A/B contribution withdrawal, retained personal saves,
version separation and current-ACL counts, Corpus lookup with one Reader body,
old backlog/keyset arrivals, private read/restore and frozen daily history.
`informationDigestDb.test.ts` exercises missing/backfilled history and delayed
scheduled snapshots across Shanghai and New York's 23/25-hour DST days;
`projectInformationMonitoringDb.test.ts` protects sealed initial versus daily
membership and late-settlement coverage. The browser uses real reading,
preference, edition and Reader routes; shell metadata is fixture-backed.
