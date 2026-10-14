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
belongs to exactly one day. Candidates are chosen by that interval.

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

## Related files

- `server/src/modules/informationDigest/`
- `server/src/modules/interestProfile/`
- `server/src/modules/sourceAnnotation/`
- `apps/web/src/modules/library/InformationDigestView.tsx`
- `apps/web/src/modules/library/InterestProfileControls.tsx`
- `apps/web/src/modules/projects/ProjectDigestPage.tsx`
- `server/test/informationDigestDb.test.ts`
- `server/test/interestProfileDb.test.ts`

## Related docs

- [library.md](library.md)
- [sources.md](sources.md)
- [automations.md](automations.md)
- [../architecture/PROJECTS.md](../architecture/PROJECTS.md)
- [../BOUNDARIES.md](../BOUNDARIES.md) — B54/B55/B56
