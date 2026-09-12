# Unimplemented Designs Extracted From Current-State Guides

Date: 2026-09-10
Status: inventory only. Not a work queue.

This file holds designs that used to live in `.agent/architecture/`,
`.agent/modules/`, `.agent/ROADMAP.md`, `.agent/ARCHITECTURE.md`,
`.agent/GLOSSARY.md`, and `docs/` as if they were current product state.
They are not implemented. Current-state guides now record only what the
code does.

Work is still pulled from [backlog.md](backlog.md) (no trigger) or
[../tasks/deferred-register.md](../tasks/deferred-register.md) (trigger-gated).
Reuse replacements stay in [platform-reuse-cleanup.md](platform-reuse-cleanup.md).
Do not treat a row here as authorization to build.

---

## 1. Frontend shell and layout

Extracted from `product-shell.md`, `frontend-layout.md`, `ARCHITECTURE.md`.

**Current fact:** `apps/web/src/core/Shell.tsx` plus `GlobalRail`,
`SceneSidebar` / `SceneTabs`, `MobileTabBar`, `SpaceSwitcher`, user menu,
theme toggle, and `FloatingQuickCapture`. Rail items are in
`apps/web/src/core/navigation.tsx`. There is no `CommandPalette`,
`ProjectFolderSwitcher`, `PanelLayout`, `RuntimeStatusBar`, or app-level
right inspector.

**Extracted design**
- Global command / search palette.
- Project Folder switcher in the chrome.
- Three-column `PanelLayout` (nav / main / assistant) plus a bottom log panel.
- Reusable `EntityCard` / `ActivityCard` / `MemoryCard` / `ProposalCard` /
  `ReviewCard` primitives.
- Shell-owned proposal badge and connection/runtime status bar.
- Offline-cache degrade when the server is unreachable.

---

## 2. Time tracking

**Current fact:** `registry.ts` registers `/time` with `planned: true`.
`TimePage` is a stub that says time tracking is under development. No
backend module.

**Extracted design:** track time records and convert them into activity
summaries.

---

## 3. Spaced repetition, Cards, media cards, Learning UI

Extracted from `spaced-repetition.md`, `media-cards.md`, `knowledge-base.md`
TODO, `ARCHITECTURE.md` learning layer, `docs/MEMORY_CONTEXT_ROADMAP.md`
path D, commercialization priority list.

**Current fact**
- Drizzle tables `cards`, `card_review_states`, `card_reviews` exist.
  No `server/src/modules/cards/` and no runtime SQL.
- `learning` HTTP module exists (`/learning*`, project-scoped learning-*).
  `learningApi` in the web client has no callers. Project Learning Area
  redirects to Pulse.
- Knowledge › Cards (`KnowledgeCardsPanel`) is an empty-state placeholder.
  Standalone `/cards` (`CardReviewPage`) is `enabled: false`, `visible: false`.

**Extracted design**
- `FlashCard` / `CardReview` product model; FSRS (or later `ts-fsrs`)
  scheduling; generation from KnowledgeItems and ActivityRecords.
- Direct CRUD under `/api/v1/knowledge/cards` and a review UI (web +
  mobile swipe: Again / Hard / Good / Easy).
- Media-card types: image occlusion, audio cloze, screenshot note, video clip.
- Resolve the unused `cards` schema versus the live `learning_items` /
  `learning_item_mastery` model before building a Space-level Cards surface.

---

## 4. Git diff review workflow

Extracted from `git-diff-review.md`.

**Current fact:** Files & Code under `projectFolders` can read tree, file,
git status, and git diff (including remote Locations). There is no
`DiffReview` / `DiffAnnotation` table, no commit-on-approve flow, and no
dedicated DiffViewer review page.

**Extracted design**
- Persist a patch set from a Run; pending review in Files & Code or
  Proposals; hunk annotations; Approve → `git commit`, Reject → discard,
  Request changes → re-run with notes.
- Planned models: `DiffReview`, `DiffAnnotation`.

---

## 5. Mobile client and sync

Extracted from `mobile-client.md`, `sync-and-conflicts.md`,
`ARCHITECTURE.md`, `ROADMAP.md`.

**Current fact:** the web app is a PWA (Vite + manifest). There is no
mobile-specific capture/review UI, no offline queue, and no multi-device
sync or conflict resolver. Desktop remains the ADR 0005 Tauri scaffold
only (`apps/web/src-tauri/`).

**Extracted design**
- Thin mobile client: quick capture, card review, inbox triage, proposal
  accept/reject; no local agent execution or Files & Code editing.
- Local-first writes for captures, drafts, card reviews, preferences;
  Space as sync unit; human-wins conflicts; append-bias for Memory versions.
- Conflict table: Memory version branch, proposal last-writer-wins,
  activity dedup by hash, Knowledge version branch, later `next_review_at`
  for cards.

---

## 6. Capture extensions

Extracted from `assistant-capture.md`.

**Current fact:** `POST /api/v1/captures` plus four destinations,
relocation/filing, and `FloatingQuickCapture`. `/capture` posts to
`POST /api/v1/activity` for the personal inbox. Voice and file/image
affordances on the composer are coming-soon UI, not backends.

**Extracted design**
- Browser extension / clipboard capture (no local store; always POST).
- Voice transcription before `raw_content`.
- File and image capture.
- Background “Memory Curator” that proposes memory / knowledge / card /
  task from raw captures.

---

## 7. Client real-time protocol

Extracted from `client-server-protocol.md`, `ARCHITECTURE.md`.

**Current fact:** REST under `/api/v1`. Agent-turn SSE at
`GET /api/v1/runs/{runId}/turn/stream`. Host pairing uses WebSocket on
the hosts module. No general product event bus.

**Extracted design**
- `ws://host/api/v1/ws?space_id=...` with subscribe/ping and events:
  `agent_run.*`, `proposal.*`, `memory.updated`, `status.changed`,
  `sync.conflict`.
- Generic `GET /api/v1/runs/{id}/stream` chunk SSE (not the turn
  projection).

---

## 8. Server status chrome

Extracted from `server-status.md`.

**Current fact:** `GET /api/v1/status` reports database, scheduler-task
liveness, jobs-worker presence, and queue depth. It does not probe LLM
providers, per-adapter tools, capability load, or sandbox-runner health.
There is no `RuntimeStatusBar` in the shell.

**Extracted design:** always-visible status bar and detail modal covering
adapters, capabilities, providers, and sandbox.

---

## 9. Memory quality (former Track B)

Extracted from `architecture/MEMORY_EVOLUTION_PLAN.md` and
`docs/MEMORY_CONTEXT_ROADMAP.md`.

**Current fact:** Knowledge retrieval (vector, rerank, rewrite, synthesis)
is implemented — see
[CONTEXT_AND_RETRIEVAL_LAYER.md](../architecture/CONTEXT_AND_RETRIEVAL_LAYER.md).
Memory maintenance scans, packets, and child `memory_archive` /
`memory_update` proposals exist — see
[MEMORY_MAINTENANCE.md](../architecture/MEMORY_MAINTENANCE.md).

**Extracted design**
- Memory ACL/sensitivity revalidation on every retrieval arm; create-safety
  / duplicate clustering; salience and recency as ranking axes;
  synthesis/gap contracts for assistant answers after Memory citation
  rules are explicit.
- ContextDigest maturity: dirty tracking, regeneration thresholds, manual
  refresh, hash observability, token-savings metrics, quality templates.
- Personal Radius / Source Horizon: private index over followed external
  sources (`SourceProfile`, `SourceDocument`, `RadiusIndex`) as candidate
  input only.
- Wiki synthesis from approved Memory/Artifacts (this overlaps the
  already-shipped Knowledge Wiki; remaining idea is automatic synthesis).
- Advanced consolidation: multi-activity synthesis, contradiction
  proposals, `reconsolidation_due`, candidate clustering, case memory.
- Knowledge-to-Memory promotion as an explicit proposal flow.
- Source-monitoring evaluator for external/untrusted Activity/Artifact
  Knowledge.
- Richer Context Ops finding-row follow-up proposal authoring.

---

## 10. Source candidate → curated wiki evidence promotion

Extracted from `SOURCE_EVIDENCE_FOUNDATION.md` (SPEC — not implemented).

**Current fact:** source `ExtractedEvidence` and curated wiki `Source` /
`KnowledgeItemSource` are separate stacks. There is no
`knowledge_source_promote` apply path that creates a `Source` from an
`ExtractedEvidence` row with provenance back to the candidate.

**Extracted design:** user-triggered, proposal-gated promotion; idempotent
on content hash / provenance; trust copied into provenance only.

---

## 11. Custom Source operator gaps

Extracted from `SOURCE_CUSTOM_SOURCE_HANDLERS.md`.

**Current fact:** custom handlers run in a child-process runner that is
not OS-sandboxed.

**Extracted design**
- Credential rotation/deletion UI; UI for creating or editing handlers.
- Reuse the namespace `sandboxRunner` (see
  [platform-reuse-cleanup.md](platform-reuse-cleanup.md)).
- Broader generated-code execution only with a real isolated
  runner/container, instance-admin enablement, proposal review for
  permission deltas, strict resource limits, Sources-only materialization,
  and durable audit.
- Proposal-gated enablement of browser / shell / dependency-install flags
  that are currently refused unconditionally.
- Browser / Python handler evaluation.

---

## 12. Capability control-plane leftovers

Extracted from `CAPABILITY_WORKFLOW_SKILL_SYSTEM.md`.

**Current fact:** file-defined registry, packs, GitHub
`blob`/`tree` / `raw.githubusercontent.com` `SKILL.md` import preview.
Binary assets are inventory metadata only.

**Extracted design**
- Native `capability` runtime adapter (declared, disabled).
- Broader `CapabilityProfile` surfaces (runtime preference, prompt
  overrides, budget, review policy beyond enablement).
- Registry / local-workspace / upload / official-catalog skill source
  types.
- Binary asset storage.
- Capability marketplace or remote install UX.

---

## 13. Credential and policy leftovers

Extracted from `CREDENTIAL_STORAGE.md`, `docs/FUTURE_ROADMAP.md`,
`ROADMAP.md`, `PRODUCT_AND_BOUNDARIES.md`.

**Current fact:** ModelProvider keys use AES-256-GCM + disk master key.
CLI login lives on the execution host (ADR 0016); the control plane does
not broker CLI credentials. Persisted API-key product storage is
feature-gated (no `api_keys` table). Active persisted policy classes
include `memory.private_placement` and `run.user_private_scope`.

**Extracted design**
- KMS/HSM envelope encryption; per-space derived subkeys.
- Additional persisted classes such as `runtime.execute`,
  `credential.access`; per-run/per-tool credential grants.
- Long-lived / agent-level / space-level / multi-user PersonalMemoryGrants;
  restricted/highly_restricted grant-readable sensitivity; consuming-only
  sub-limit; admin grant-stats; full `egress_review` shared-content apply
  (today metadata-only); semantic leakage detection.
- Dedicated grant-management UI and frontend component tests for the
  grant/egress flow.

---

## 14. Publications, federation, PersonalView

Extracted from `NON_GOALS_AND_DISABLED_SURFACES.md`,
`docs/FUTURE_ROADMAP.md`, `docs/FEDERATED_ACCESS_MODEL.md`,
`docs/SPACE_MODEL.md`, `docs/MEMORY_CONTEXT_ROADMAP.md`.

**Current fact:** targeted immutable publication/import is implemented
(`publications` module, `/publications`). `/me/*` aggregates exist
(summary, timeline, pending, retrieval). There is no public internet
sharing, no cross-instance federation, and no `PersonalView` /
`ParticipationRecord` model as originally sketched.

**Extracted design**
- Cross-instance publication, anonymous catalogs, remote fetch, distributed
  identity, revocation, cache policy.
- PersonalView / ParticipationRecord that aggregate without copying raw
  shared content.
- `/me` pagination and caching for large sets.

---

## 15. Ingestion, crawlers, connectors

**Current fact:** Sources connections, recipes, extraction, Library, and
imported CLI sessions exist. Internal Knowledge/Memory vector recall uses
pgvector. There is no connector marketplace, no web crawler, and no
vector index over an external corpus.

**Extracted design:** marketplace / integration lifecycle; broad
autonomous discovery and crawling; external-corpus vector index;
IM/email/channel adapters (former P8); always-on trigger budgets as a
general vocabulary (former P9 — Sources already has cooldown/backlog
caps).

---

## 16. Runtime, adapters, verification

Extracted from `ROADMAP_AND_FUTURE_RISKS.md` and ADR 0005.

**Current fact:** `opencode` RuntimeAdapterSpec exists. `one_shot_docker`
is not the product CLI path (host daemon is). Verification Engine
`manual_review` / `model_judge` return deferred (see backlog A2.1).

**Extracted design**
- Harden Docker isolation / egress-enabled profile; cross-process
  subprocess termination.
- External webhook/cron trigger registry after manual/scheduled
  automation is the only fire path we keep.
- Self-hosted TS agent loop, tool scheduler, MCP client (former P6/P7).
- Provider privacy/compliance policy rules (former H3).
- Per-session chat concurrency guard (former P2).
- Full desktop app beyond the Tauri scaffold.

---

## 17. Operations and scale

**Current fact:** local `BackupService` and manual restore scripts.
Deployment jobs persist (`deployment_jobs`, ADR 0020).

**Extracted design**
- Cloud/offsite backup sync; automatic restore; distributed locking;
  production-grade rate limits; bulk Memory export and retention/delete
  semantics; operator runbook page.
- Artifact user-edit/revision tracking (backlog D1.2).
- Artifact archive/delete API (if still absent when this is pulled).

---

## 18. Commercialization / enterprise

Extracted from `commercialization.md`.

**Current fact:** personal / household / small-team, single self-hosted
instance, browser UI. No billing, org SSO, or marketplace.

**Extracted design (do not build without commercial demand)**
- Enterprise SaaS multi-tenancy, subscription billing, complex RBAC/ABAC,
  org admin console, SCIM, Kubernetes runners, container pools, plugin
  marketplace, SOC2/HIPAA/GDPR export, full BYO-provider console.
- Rules that are not current invariants: disable any adapter without
  breaking core features; BYO keys/endpoints as an enterprise product
  surface; per-space provider/data policy UI; commercial CLI license
  review.

**Extracted build order (obsolete as a sequence; several items have
shipped):** flashcards, family/team polish, diff review, then everything
else.

---

## 19. Ontology object types not in the root enum

Extracted from `CLAIM_FACT_ATOM_MODEL.md`.

**Current fact:** `space_objects.object_type` is
`knowledge_item`, `note`, `source`, `person`, `organization`, `claim`,
`inquiry_thread`, `decision_case`, `experiment`. `project` and
`project_folder` are entities without being `space_objects` rows.

**Extracted candidates, not in the enum:** `asset`, `event`, `task`,
`document` (and a `project` root row). Do not add them without a product
need and B12G review.

---

## 20. Disabled / reserved surfaces (facts, for routing)

These are current absences, not designs. Listed so guides do not re-grow
speculative sections:

- Public SaaS / multi-tenant launch.
- Automatic system self-evolution (removed).
- Deployment from an Agent, automation, or Proposal.
- Arbitrary deployer commands beyond the allowlist.
- Runtime adapter bypass of credential resolver or path policy.
- Automatic Memory promotion from source/evidence.
- Generic `DomainObject` registry or schema editor.
- Full plugin/provider marketplace.
- Unconstrained self-evolution.
- Domain kernel integrations (health, finance-in-kernel, home automation).
  Official plugins `diary` and `finance_ledger` are the opt-in path.

---

## 21. Database concurrency leftovers

Extracted from `DATABASE_AND_TRANSACTIONS.md`.

**Current fact:** process-local advisory locks; `RunStep` ordering uses
`MAX()+1`. `deployment_jobs` persist (ADR 0020).

**Extracted design**
- Distributed multi-host locking.
- Safer `RunStep` ordering (DB sequence or distributed counter) if
  concurrent writers appear.

---

## 22. Policy leftover wiring

Extracted from `policy.md` and `docs/POLICY_AND_PRIVACY_BOUNDARIES.md`.

**Current fact:** reserved actions are registered and `PolicyGateway`
denies them (`policy_action_not_implemented`). `memory.create` /
`update` / `archive` are enforced only through `proposal.apply`.
Policy rows are domain-specific. Deployment jobs do not use the reserved
`deployment.propose` / `deployment.execute` actions.

**Extracted design**
- Wire reserved actions to real `PolicyGateway.enforce()` call sites
  (`capability.*`, `tool_binding.enable`, `context.use_personal_grant`,
  `workspace.*`, `artifact.export`, `proposal.approve`,
  `memory.read_private`, `memory.promote_shared`).
- Per-user / per-project approval capabilities.
- Space-level policy row overrides.
- `RunDelegation.status` following child-run terminal states.

---

## 23. Source / retrieval leftovers

Extracted from `SOURCE_CONNECTOR_CONSENT.md` and
`CONTEXT_AND_RETRIEVAL_LAYER.md`.

**Current fact:** source read/egress gates cover the listed consumers.
Chat context uses a conservative `external_provider` destination.
Ollama runtime-host tool calling is not implemented (explicit fail).
Vector recall is halfvec HNSW at the default dimension.

**Extracted design**
- Connector refresh/purge edge cases beyond current scheduler/worker
  gates; a dedicated shared-consent source table if multiple connectors
  need one grant.
- Chat-turn artifact attachments / Evidence Packs reused through the
  same gates; pass the real chat provider destination into the collector.
- Source-policy version/hash on artifact / context-pack audit metadata.
- Space-wide source governance docs and API affordances.
- True BM25 and non-default-dimension ANN.
- Ollama runtime-host tool calling.

---

## 24. Claim, Memory, ontology, and template leftovers

Extracted from `CLAIM_FACT_ATOM_MODEL.md`, `MEMORY_MODEL.md`,
`ONTOLOGY.md`, `agents.md`, `EVOLUTION_SIGNAL_SYSTEM.md`,
`OFFICIAL_OPTIONAL_MODULES.md`.

**Current fact:** Object Schema Registry exists; dynamic schema packs
are rejected. `memory_relations` has a live CHECK, one writer, no
reader. Agent template create/publish endpoints exist; the Agents UI
does not author custom templates. Plugin settings are opaque JSON.
The proposal lifecycle has no `request_changes` status.

**Extracted design**
- Validate Memory `subject_user_id` / `owner_user_id` against membership.
- Richer `sensitivity_level` policy; optional audit-log dedup when the
  same memory is injected several ways in one request.
- Shrink `memory_relations` to what is written, or declare it as a link
  type set when Memory joins the ontology.
- People / assets / events / tasks product modules on `space_objects`.
- Source-drift evaluator and scheduled claim-source review.
- Frontend claim workspace and richer Context Brief claim-review UX.
- Automatic Memory claim extraction (needs its own privacy design).
- Custom-template authoring UI.
- `request_changes` proposal status.
- Full plugin settings engine; third-party module sandbox/SDK.

---

## 25. Host pairing leftovers

Extracted from `hosts.md` Known P1 gaps. Do not treat these as a
substitute for [../tasks/deferred-register.md](../tasks/deferred-register.md).

**Current fact:** Conversation dispatch uses the pinned Location; Task
host choice is explicit. Expired `pending_pairing` / `revoked` host
names still occupy `uq_hosts_owner_name`. Remote propose→apply is
explicitly not settled (ADR 0016).

**Extracted design**
- Scored multi-location routing / lease scheduler.
- Cleanup policy for expired pending and retained revoked host names.
- Remote proposal/apply governance, content sync, divergence detection,
  quota probing, Windows-native/WSL hardware verification.

---

## 26. Frontend modules that are only stubs or absent

Extracted from `FRONTEND_INFORMATION_ARCHITECTURE.md` §9.

**Current fact:** Graph at `/graph` is implemented. Cards and Time are
stubs (see §2–§3). There is no Editor or Calendar module.

**Extracted design**
- File editor + save API; calendar/scheduling model.
- Home per-Space aggregates: captures waiting, review packets ready, cards due
  (must be real backend endpoints, not a frontend fan-out).
- Activity / Run / Artifact cross-links (post-consolidate navigation to
  proposals; post-accept link to the created memory).
- Board visibility notice for shared-space use.

---

## See also

- [backlog.md](backlog.md)
- [../tasks/deferred-register.md](../tasks/deferred-register.md)
- [platform-reuse-cleanup.md](platform-reuse-cleanup.md)
- [capability-shrink-plan.md](capability-shrink-plan.md)
- [unattended-execution-hardening-plan.md](unattended-execution-hardening-plan.md)
