# Module: Information Digest

## Status

Implemented. `server/src/modules/informationDigest/` owns the persisted daily
personal and Project information digests, interest-profile HTTP surface, and
the system-managed Automation target. Source annotation and the private
interest-profile fact model remain separate support packages.

## Ownership and routes

- `GET /api/v1/spaces/:spaceId/information-digests/personal` returns one
  owner-private snapshot per UTC day. Generation is lazy-safe and also runs
  from the hidden daily Automation.
- `GET /api/v1/spaces/:spaceId/projects/:projectId/information-digests` returns
  one shared Project snapshot per UTC day, hydrated with only the current
  reader's private state.
- `/api/v1/spaces/:spaceId/interest-profile*` is the authenticated owner-only
  surface for the profile snapshot, settings, topic candidate decisions,
  direct topic create/edit/archive, optional starter packs, and explicit
  bounded history backfill.
- Digest-item routes own explicit serendipity feedback and the one-way action
  that files an item into an active Project Corpus through the Project writer
  gate.

## Personal pipeline

The daily transaction takes a scope/day advisory lock, rechecks the snapshot,
and runs the deterministic interest-profile fact layer before selecting. The
fact layer consumes successful shared annotations joined to this reader's
private state. Read material contributes recency-weighted domain coverage and
recurring topic phrases; items explicitly marked `ignored` contribute neither
coverage nor topic candidates. An observation ledger makes repeated passes
idempotent.

Fine-grained topics are owner data. Recurring normalized phrases become
deterministic candidates after configurable occurrence/read thresholds; no
model call invents or activates a topic. Only owner acceptance or direct owner
creation activates one. This confirmation-gated deterministic design is the
semantic boundary; an Agent-proposal dependency is intentionally not part of
the current implementation.

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
annotation row, then wakes the existing annotation job. Failed/skipped rows use
the existing explicit annotation retry path instead of being silently reset.

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

Project selection reads annotated Source items entering the Project Corpus on
the UTC day and ranks by Project triage/confidence, not personal interests. It
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
