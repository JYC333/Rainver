# Project Conversational Advancement Plan

Date: 2026-08-16
Status: **SUSPENDED 2026-08-21** — Phases C and D are on hold pending
[plans/acp-runtime-replatform-plan.md](acp-runtime-replatform-plan.md); the
resume condition is **its two-week acceptance gate passing** (amended
2026-08-21 and again 2026-08-22 as the control-center line's plan document
changed hands; the phase-1 and phase-2 plans are both retired, ledgers in git
history). Room's future role is also **narrowed in place** (decided in the
phase-2 grilling as its C1, carried forward as a standing decision in the
active plan's §6): Room returns as a
**dispatch/supervision entry** for execution hosts ("create a thread on my
desktop for X", "summarize last night's threads") — it never relays the
turn-by-turn work conversation itself, which belongs exclusively to the
direct task-thread surface. Phase C/D scope will be revised in that light
rather than resumed unchanged. Do not advance Phase C without re-reading
acp-runtime-replatform-plan.md first.

Prior status (superseded by the suspension above, kept for history): Phase A
completed 2026-08-16; Phase B completed 2026-08-16; gate to
Phase C open (see "Gate between Phases A+B and Phase C" — waiting on the user
completing one real round conclusion and one knowledge landing through
conversation). 2026-08-18: a reliability hardening insert
(`room-advancement-reliability-plan.md`, now retired — its content lives in
git history and in `.agent/architecture/SYSTEM_ACTIONS.md`/`.agent/modules/
rooms.md`) was approved and landed before this gate, in 4 phases through
2026-08-20: idempotent proposal creation and removal of the forced-execution
gate, a domain-registered continuation contract replacing hardcoded
proposal-continuation prose, completion-event continuations, and
`research.start_acquisition` — the direct Workflow-start verb, giving the
Room Manager Agent both research-execution tools (`agent.delegate` and
`research.start_acquisition`) it was missing. Its approval re-examined and
re-affirmed direction decisions 1 and 3 on first-principles grounds.

## Execution ledger

### Phase A — completed 2026-08-16

Delivered: `inquiry.record_conclusion` (new `inquiry_conclusion` proposal_type
+ applier calling `InquiryIterationService.recordIteration` under the
accepting user's identity) and `inquiry.promote_knowledge`
(`KnowledgePromotionCandidateService.proposeFromThreadForAgent` combining
`createFromThread` + immediate `decideCandidate(promote)`), both wired as
generic-transport agent tools in `agentToolGateway.ts`; an inline Proposal
review card in the Room conversation (`RoomActionPreviewCard`, refreshes
against the live Proposal on mount rather than trusting the one-time
finalizer snapshot); Room prompt now prefixed with a domain-neutral Project
state block (`buildRoomProjectStateContext`, from `ProjectOverviewService`).
Docs updated: `.agent/architecture/SYSTEM_ACTIONS.md`,
`.agent/modules/rooms.md`.

Review: 1 discovery + 1 closure reviewer (of a 3-reviewer budget). Discovery
found 1 major (stale Proposal-card status on remount — no live refresh
existed) + 2 minor (propose-time authorization used
`assertProjectReadable` instead of the sibling-service `assertProjectWriter`
convention; an unlocked idempotency check in the combined promote-knowledge
call could surface a raw constraint violation on a genuine concurrent retry).
All three repaired in one batch; closure confirmed all three fixed with no
repair-induced or newly-exposed blocker/major.

Accepted minor defer: closure review found the concurrency fix for the third
finding stops the unhandled throw and duplicate-proposal risk, but a
genuinely concurrent identical retry can still leave the *other* transaction's
`knowledge_promotion_candidates` row orphaned at `status='pending'` — a
pre-existing condition the original finding named, not introduced by the
repair. Data-hygiene only (a human could later double-promote it manually);
no correctness or security impact. Left open — revisit only if real
concurrent duplicate-tool-call retries are observed in practice.

Verification: `pnpm run typecheck` clean across `packages/protocol`,
`server/`, `apps/web/`. Full suites green after repair: protocol 39/39 files
(196 tests), server 437/437 files (3412 tests, real Postgres), web 97/97
files (612 tests).

### Phase B — completed 2026-08-16

Delivered: `RoomProjectStatePanel`, a persistent panel beside the Room
conversation (`AgentGroupsPage.tsx`) fetching the same
`projectsApi.getOverview` the Project Overview page uses and rendering
`current_state_summary`, `next_actions`, and `attention`, each item
deep-linking into its owning Area; a fetch failure degrades to "Project state
unavailable" rather than blocking the Room. The Inquiry kind→stage vocabulary
moved from `apps/web/.../inquiryArea/stages.ts` into
`packages/protocol/src/inquiry.ts` (`Inquiry*`-prefixed exports); `stages.ts`
re-exports the original names as live aliases so its four page consumers
needed no changes, and its substantial derived-state logic
(`deriveStages`/`recommendStep`/etc.) stayed put — only the static
vocabulary moved. Docs updated: `.agent/modules/rooms.md`.

Scope decision (recorded before implementation, via explicit user question):
the plan's "stage compass" panel row is deferred — no Project-level Inquiry
stage rollup exists anywhere in the codebase (`inquiryEntitySummaryAdapter`
only reports count + ok/attention/blocked, no per-stage breakdown), and
building one is new aggregation work, not the "small mapping move" the plan
promised. See the Deferred table.

Review: 1 discovery reviewer (of a 3-reviewer budget; closure skipped — no
blocker or major finding). Discovery found zero blocker/major and three
minor, non-blocking observations: the panel's `overflow-auto` was inert
without a height constraint (fixed: added `max-h-[620px]`, matching the
conversation card); the new panel test's two fixture hrefs shared a
substring and could not have caught a "Next"/"Needs attention" section swap
(fixed: distinct hrefs per fixture, with a negative assertion); the file
housing the new component (`AgentGroupsPage.tsx`) is the module's largest,
but this follows Phase A's own precedent of adding Room-page components
in-file rather than introducing a new pattern (left as is).

Verification: `pnpm run typecheck` clean across `packages/protocol`,
`server/`, `apps/web/`. Full suites green after repair: protocol 39/39 files
(196 tests), server 437/437 files (3412 tests, real Postgres), web 97/97
files (613 tests).

### Phase A+B reachability patch — 2026-08-16

State: completed. Phase base:
`eb28457cd201334d0a27cf7c8bec58d80ce2312e`.
Owned scope: Room scenario tool allowance and immutable Run grant snapshot;
one-click Project Room + first-conversation entry; focused backend/frontend
tests; current-state Room/System Action docs. Excludes Project landing/nav,
shared-Room retrieval, Agent permission administration, and separating the
overloaded `capabilities_json` field. Intended commit title:
`fix(rooms): make conversational advancement reachable`.

External review consent: the user's explicit invocation of
`$phase-gated-implementation` authorizes discovery, closure, complementary,
and integration review of this plan's selected repository changes through the
external Codex service for this run. Reusable `codex review` command approval
was granted for this run.

Readiness findings before independent discovery: local closure review found
the follow-up catalog refresh could override `openRoom`'s result and leave the
creating state stuck, and the Project empty state still rendered the full
roster form beside the promised one-click entry. Both are being repaired with
focused frontend regression coverage before discovery.

Readiness packet: Room dispatch supplies a typed, two-action allowance to all
root and grouped Run creation paths only when `group.room_id` is present; Run
creation intersects that allowance with the same declared capabilities and
registry checks used for AgentVersion permissions, then persists the allowance
and resulting grants in the immutable `permission_snapshot_json`. The allowance excludes every
retrieval action, and a real-Postgres workflow test contrasts the Room Run with
the same Agent's non-Room Run. The Project empty state hides the roster form,
creates a default Room plus its first conversation, preserves composed input
on create failure, refreshes after partial failure, and cannot remain stuck if
that refresh fails. Potential bypasses inspected: first/root and later grouped
Run paths, non-Room agent groups, direct queued Runs, retrieval enablement via
`capabilities_json`, and the production work-context rebind path.

Focused verification after the discovery repair batch: server and web
typechecks pass; `AgentGroupsPage.test.tsx` passes 10/10;
`runRepositorySqlShape.test.ts` passes 7/7; the adjacent shared-Proposal SQL
consumers pass 51/51; `git diff --check` passes. The initially unavailable
database verification was rerun in an approved environment with Docker and
real PostgreSQL access. Final broad verification passes: protocol 39/39 files
(196 tests), server 437/437 files (3414 tests, including the affected real
PostgreSQL suites), and web 97/97 files (616 tests). Diff scope includes the
direct Proposal consumers needed to preserve Room visibility and grants.

Review invocation ledger:

- Invocation ID: `REACHABILITY-DISCOVERY`; role: discovery; state: completed;
  remote session: `01a00c26-3b36-7142-bbf7-a755797e3811`; successful reviewer
  sessions: 1/3; result: two major and one correctness finding, coverage
  complete. Reusable `codex review` command approval granted.
- Invocation ID: `REACHABILITY-CLOSURE-1`; role: closure; state: completed;
  remote session: `01a00c33-b56b-73a2-8d87-e1403bdeeb71`; successful reviewer
  sessions: 2/3; result: `REV-001` and `REV-003` closed and the visibility leak
  in `REV-002` closed, but one repair-induced major remained.
- Invocation ID: `REACHABILITY-CLOSURE-2`; role: closure; state: completed;
  remote session: `01a00c38-449f-7780-8eee-e70763c4d35c`; successful reviewer
  sessions: 3/3; result: `REV-004` closed for Knowledge creation, but one
  previously-missed major remains. The phase review budget is exhausted, so
  another reviewer requires explicit user authorization.
- Invocation ID: `REACHABILITY-CLOSURE-3`; role: closure; state: completed;
  remote session: `01a00c3e-8cf4-7d22-a886-9d3b069072f9`;
  this explicitly user-authorized session was outside the original 3-reviewer
  phase budget. Result: `REV-005` and every prior blocker/major closed; no new
  actionable correctness or security finding.

Final integration gate:

- Invocation ID: `INTEGRATION-DISCOVERY`; role: integration discovery; state:
  completed; remote session: `01a00c4a-fde6-7480-b71e-b25fdd0da609`;
  successful integration reviewer sessions: 1/2; result: two P1 correctness
  findings, repaired as one batch. `INT-001`: agent-authored Proposals exposed
  an inline Reject action, but rejection authority recognized only a direct
  `created_by_user_id`; the trusted instructing `owner_user_id` now receives
  creator-equivalent rejection authority only when Agent attribution is
  present. `INT-002`: the successful one-click path retained the committed
  Room only after its first conversation failed; it now inserts the Room into
  local state immediately after Room creation, before conversation, detail,
  or catalog requests can fail or lag.
- Invocation ID: `INTEGRATION-CLOSURE-1`; role: integration closure; state:
  completed; remote session: `01a00c53-e051-7820-83f0-0d72b8f785ec`;
  successful integration reviewer sessions: 2/2; result: `INT-001` closed,
  but `INT-002` remained open because a successful yet stale catalog response
  could still replace the optimistic Room. The normal integration budget was
  exhausted with this P1 open.
- Invocation ID: `INTEGRATION-CLOSURE-2`; role: integration closure; state:
  completed; remote session: `01a00c79-40cc-75d0-870f-c14ab0339b73`;
  this session was explicitly user-authorized outside the normal 2/2
  integration reviewer budget. Result: `INT-001` remained closed, but
  `INT-002` remained open for out-of-order concurrent catalog completions: a
  newer response could observe the Room and clear its pending entry before an
  older empty response replaced the list.
- Invocation ID: `INTEGRATION-CLOSURE-3`; role: comprehensive integration
  closure; state: completed; remote session:
  `01a00c7e-ee07-7d01-b673-a3cbc99907a5`; this additional session was
  explicitly user-authorized and exhaustively inspected the complete
  effective range in one pass. Result: `INT-001` and `INT-002` closed; the
  server/security paths were clean; one separate P2 frontend correctness
  issue was found and repaired: a retained pending Room from Space A could be
  merged into Space B's catalog after an in-place active-Space switch.

Focused verification after the integration repair batch: server typecheck and
`proposalApplyService.test.ts` 2/2 pass; web typecheck and
`AgentGroupsPage.test.tsx` 10/10 pass; `git diff --check` passes.
After the final `INT-002` repair, every catalog load merges a short-lived map
of committed Rooms that the server list has not observed yet; the map entry is
removed as soon as an authoritative list includes that Room. Web typecheck and
the Room page tests (10/10), including a successful stale-list plus failed
detail-read regression, pass.
The concurrent completion repair assigns every catalog request a monotonic
sequence and permits only the newest request to update catalog state or clear
pending Rooms. Its deterministic regression resolves a newer response that
observes the Room before an older empty response and proves the old completion
cannot restore the one-click CTA. Web typecheck and the Room page tests pass
11/11 after this repair.
The comprehensive-review P2 repair additionally requires every pending Room
to match `activeSpaceId` before merging it into the visible catalog. The
regression retains the component, switches from Space A to Space B, and proves
Space A's optimistic Room is absent in Space B. Final focused Room tests pass
11/11; protocol passes 39/39 files (196 tests); server passes 437/437 files
(3414 tests, real PostgreSQL); web passes 97/97 files (617 tests). The first
final web-wide run hit one unrelated Assistant stream-disconnect timeout; its
immediate isolated rerun passed 7/7 and the subsequent full rerun passed all
617 tests.

Finding ledger:

- `REV-001` (major): production Work Context binding recomputed grants from
  the AgentVersion and removed the Room allowance before execution. Repair:
  persist the scenario allowance in `permission_snapshot_json` and reuse it
  during binding; extend the Room database test through the rebind.
- `REV-002` (major/security): both newly reachable direct executors created
  Space-shared Proposals from selected-user Room Runs. Repair: propagate Run
  visibility, inherit Run grants transactionally, and keep the knowledge
  action's intermediate Candidate private to the instructor.
- `REV-003` (correctness): if conversation creation and the broad catalog
  refresh both failed, the committed Room stayed hidden and the one-click CTA
  could duplicate it. Repair: retain the created Room locally and navigate to
  it independently of catalog refresh.
- Local repair review: private agent-authored Proposals would have had no
  owner after propagating private Run visibility. Repair: retain Agent
  attribution while explicitly assigning the instructing user as owner.
- Local repair review: an empty or malformed persisted scenario allowance
  could have fallen back to broader AgentVersion grants during rebind. Repair:
  distinguish an absent allowance from an invalid one and fail closed once
  scenario metadata is present.
- `REV-004` (major, repair-induced): the selected-user Knowledge repair made
  the Candidate payload private while retaining Agent attribution, but the
  Knowledge create applier recognized only `created_by_user_id` as a human
  owner and therefore rejected acceptance. Repair: carry proposal
  `owner_user_id` into apply context and recognize it as the trusted human
  owner only for an Agent-authored Proposal, retaining Agent attribution.
  Post-repair server typecheck and 58 non-database affected tests pass; the
  Knowledge database acceptance test remains environmentally blocked.
- `REV-005` (major, previously-missed; closed): the same reachable action accepts
  `supersedes_knowledge_item_id` and emits an Agent-authored
  `knowledge_update`, but update target read/ownership checks still use only
  the null `created_by_user_id` instead of the trusted effective Proposal
  owner. Canonical acceptance therefore rejects a valid Room-authored update.
  No repair has been made after the final closure because the skill requires a
  stop once the 3/3 per-phase reviewer budget is exhausted with a major open.
  The user subsequently authorized continuation and one additional reviewer.
  Repair: centralize the trusted human owner calculation and use it for
  Knowledge update target read/ownership checks; propagate Proposal owner
  through the grant-driven apply entrypoint; extend the Room action database
  test through successful `knowledge_update` acceptance.
  Post-repair server typecheck, 58 affected non-database tests, and
  `git diff --check` pass. Final broad server verification executes the real
  database coverage and passes 437/437 files (3414 tests).
- `INT-003` (P2, comprehensive integration review; closed locally): pending
  optimistic Rooms were not scoped to the active Space, so retained component
  state could show a Space A Room after navigating to Space B. Repair: filter
  pending Rooms by `activeSpaceId` before catalog merge and cover the retained
  component Space-switch path. No additional external review loop was opened;
  the user explicitly requested a consolidated review followed by repair.

Raised by the user on first real use: Phase A and B shipped but nothing was
reachable. Two causes, both found by inspection after the complaint:

1. **The two new actions could never be granted to any Agent.**
   `buildRunToolGrants` requires the AgentVersion's
   `tool_permissions_json.allowed_tools` to permit an action, agent creation
   defaults that field to `{}`, missing-means-deny is a deliberately tested
   invariant, no production code writes it, and no product surface edits it.
   Every Agent created through the product therefore holds zero tools — this
   predates and is broader than this plan (`task.plan.propose` is equally
   unreachable), but it makes the plan's own A+B→C gate impossible to pass.
   Phase A's review had accepted "capability granting is an admin step",
   which was true of the convention and wrong about the product: that admin
   step does not exist.
2. **Room entry cost.** Reaching a first message meant a create-Room form
   (title, manager Agent, other Agents, people) and then a separate
   "New conversation" — the concept load this plan exists to remove, moved
   to a different screen.

Decision (user, after rejecting per-Agent capability seeding on the grounds
that it binds a capability to something the Room roster fixes at creation):
permission for Room conversation belongs to the scenario, not the Agent.
Delivered: `ROOM_CONVERSATION_TOOL_ALLOWANCE` +
`RunCreateInput.scenario_tool_allowance`, applied by
`dispatchMessageInTransaction` only when the group has a `room_id`;
`buildRunToolGrants`, its intersection, and its fail-closed behaviour are
unchanged. Room creation now opens its first conversation in the same action,
and a Project with no Room offers a single "Start a conversation" button
instead of a roster form. Docs updated:
`.agent/architecture/SYSTEM_ACTIONS.md` (new "Scenario tool allowances"
section), `.agent/modules/rooms.md`.

Reversed during review — read-only retrieval was in the first cut of the
allowance and was removed. The same list is written to `capabilities_json`,
and `explicitRetrievalToolDomainsFromRun` treats a retrieval action id there
as the *enablement switch* for that domain, so listing it does not merely
permit a tool. Retrieval then executes under `instructed_by_user_id` — the
message sender, whose reads include their own `private` content — while the
Run's reply is visible to every Room member, making "ask a question in a
shared Room" a path to surfacing one member's private material to the others.
Excluding memory (the original precaution) was not sufficient, because
Knowledge, notes, sources, and Project summaries carry the same per-user
visibility model. Grounding a drafted conclusion in Project material is still
wanted; it needs retrieval scoped to what the whole Room may read, which is
separate work. The review also found and fixed: the one-click entry orphaned
Rooms on a partial failure and re-fired on every click; a failed create wiped
the user's composed roster; the allowance constant was untyped (now
`SystemActionId`, so a typo fails the build instead of failing closed and
silently). Recorded, not fixed: `capabilities_json` is overloaded as both the
system-action declaration and the runtime-skill capability list, and the
allowance is not persisted on the run row, so a future path that recomputes
grants from the AgentVersion would revert a Room Run — both documented in
`SYSTEM_ACTIONS.md`, both inert today.

Not done, deliberately: the Project landing page is still Overview and the
sidebar is unchanged. Making conversation the default surface is Phase D
work and stays behind the dogfooding gate.

## Purpose

Make the Project loop completable through conversation. Dogfooding evidence
(2026-08-16, real research Project): the loop breaks in the back half —
Research → Evidence worked, Digest → Conclude → Land did not. Causes were not
missing backend capability but (a) no guidance from "evidence read" to "record
the conclusion", and (b) concept load: the primary workflow requires the user
to learn and manually maintain internal vocabulary (Thread, round, close-out,
position) before their own research can advance.

This plan does **not** redesign navigation, delete Areas, or introduce a
generic Project-advancement abstraction. It adds one conversational operating
path on existing infrastructure, then removes old surfaces only where the new
path demonstrably takes over.

## Direction decisions (recorded 2026-08-16)

1. **Structure is a compass, not a gate.** Stage/round state is inferred by
   the system and confirmed by the user, never declared by the user. Jumping
   between stages and raising new questions mid-conversation are first-class,
   not process violations.
2. **Room is the command surface**, not Overview. The target shape is
   conversation in the center, a backend-fed state panel beside it, and Areas
   retained as deep-link inspectors ("escape hatch and detailed workspace, not
   the primary workflow").
3. **Generality by contract discipline, not by abstraction layer.** The Room
   agent's contract is domain-neutral: Project state (mode projection +
   attention + next focus) + the registered system-action list → intent →
   drafted Proposal. No research-specific assumption may live in the Room
   agent contract or context assembly. Domains extend the surface by
   registering their own actions (`inquiry.*` now; delivery already has
   `task.plan.propose`). No `project.advance`-style generic verb layer until a
   second domain proves its shape.
3a. **Conversation replaces the operating path, not visibility.** Three-layer
   split: operating entry → conversation; ambient awareness → state panel;
   inspection/monitoring → existing Area pages, reached by deep links
   (`focus_set` / `next_actions` / attention `href`s). Run/workflow monitoring
   is never conversation-only.
4. **Deletion is the success metric.** After Phase C is dogfooded, a dedicated
   reduction pass must produce a real cut list (creation dialogs, thread-page
   ceremony forms, sidebar regrouping). If little can be cut, the
   conversational path failed to take over and the direction itself is
   falsified.

## Existing infrastructure this plan reuses (verified against code)

- **Recommendation authority is already backend.**
  `inquiry_threads.next_focus_kind` is projected from open steps with single
  write authority in `server/src/modules/inquiry/stepService.ts` (ADR 0012);
  `adviceService` supplies `recommended_focus_kind`. Frontend
  `apps/web/src/modules/projects/inquiryArea/stages.ts` only groups the eight
  focus kinds into five display stages.
- **Project state contracts exist and are mode-generic.**
  `ModeOverviewProjection` (`server/src/modules/projects/overviewRegistry.ts`)
  carries `current_state_summary` / `focus_set` / `next_actions`;
  `attentionRegistry.ts` items are computed, never authoritative, and carry
  action descriptors with `href`s.
- **Rooms are complete as dispatch infrastructure** (`.agent/modules/rooms.md`):
  project-bound, per-message instructing identity, per-speaker credential
  resolution, one `agent_run_group` per message.
- **The gap is the domain-action layer.** The system-action registry holds six
  actions; none advances Inquiry structure. `source.raise_as_question`
  (created via `standingComparisonService.ts` advice) is the nearest template.
- **Conclusion recording today is a user-direct write.** Iterations are
  created directly, explicitly without proposal
  (`server/src/modules/inquiry/iterationService.ts` — "edits to the confirmed
  position create this directly"). The new action adds a proposal-gated path
  for *agent-drafted* conclusions; it does not touch the user-direct path.
- **Knowledge landing has one canonical lifecycle** — `knowledgePromotion`
  (candidateService → Knowledge Review). The new action must feed it, never
  open a second route into Knowledge.

## Phase A — Conversational close-out (with Phase B in one milestone)

Two system actions plus the in-conversation review card.

- `inquiry.record_conclusion` — the user says, in a Project Room, that a
  question is ready to conclude; the agent drafts the conclusion from Thread
  state (evidence, notes, signals); accepting the Proposal materializes the
  Iteration (position movement + round close via existing
  `iterationService` internals). The applier owns the write; the agent owns
  only the draft.
- `inquiry.promote_knowledge` — landing a concluded round into the existing
  knowledgePromotion candidate flow, surfaced through the same Proposal gate.
- **Inline Proposal card in the Room conversation**: title + drafted body +
  accept/reject, calling the existing proposals accept API. No inline editing
  — revisions are requested in conversation and the agent re-drafts. Approval
  never requires leaving the Room (standard Proposals surfaces still work).
- Thread disambiguation is conversational: the agent resolves which Thread
  from context and asks when ambiguous.
- Room agent context assembly per decision 3: mode projection + attention +
  next-focus + registered actions. Domain-neutral prompt.

Out of scope for Phase A: `inquiry.raise_question` (mid-conversation new
questions), decision-case and delivery-task exits, approval auto-grants
(`actionApprovalGrantService` integration waits for observed confirmation
fatigue), any Area-page changes.

## Phase B — Room state panel

- Render the existing mode projection + attention + next-focus contracts as a
  persistent panel beside the Room conversation: current state summary, stage
  compass, running operations, pending review items — each deep-linking into
  its owning Area.
- Move the kind→stage grouping from `stages.ts` into a shared layer so the
  panel and the agent context consume one grouping. This is a small mapping
  move, not an engine migration.

## Gate between Phases A+B and Phase C

Not time-based. The user completes one real round conclusion and one
knowledge landing through conversation and judges the feel correct. If the
drafts are chronically wrong or inline confirmation feels wrong, Phase C's
design changes — do not start it early.

## Phase C — Conversational creation

- Thin Project bootstrap: "new project" creates a minimal row (placeholder
  name allowed; PROJECTS.md creation already requires only name + optional
  Brief + `primary_mode`) and lands directly in its Room.
- The agent asks what the user is trying to accomplish and drafts the Brief
  via Proposal (same inline card).
- Research setup (`ResearchSetupDialog` and friends) leaves the required
  path: the agent configures on demand through conversation; the dialogs
  remain as expert surfaces.

## Phase D — Reduction pass (mandatory, evidence-based)

After Phase C is dogfooded, produce and execute a cut list against the
criterion "surfaces reached only via state-panel deep links lose their
standing entries". Named candidates (to be confirmed by usage, not by
design): old creation dialogs; thread-page ceremony surfaces (CloseOutForm as
a primary path; user-facing round/position vocabulary); the 15-item Project
sidebar regrouped to a few standing entries plus a collapsed Area index; the
monolithic Thread page layout. Expert/debug access paths must survive per the
standing non-goal rules.

## Deferred (with triggers)

| Item | Trigger |
|---|---|
| `inquiry.raise_question` conversational thread creation | Phase A feel confirmed; check `source.raise_as_question` applier reuse first |
| Decision-case / delivery-task landing exits | A real Project needs them |
| Approval auto-grant for conversation-instructed actions | Observed confirmation fatigue during dogfooding |
| Generic Project-level advancement verbs | A second domain registers conversational actions and duplicates shape |
| Overview page final role (likely: full-screen state panel) | Phase D evidence |
| Area demotion beyond the named cut list | Phase D evidence |
| Project-level Inquiry stage rollup in the Room state panel ("2 Threads in Acquire, 1 in Digest") | Real dogfooding shows the panel's current_state_summary/next_actions/attention rows are not enough situational awareness without it — confirmed 2026-08-16 as out of scope for Phase B's "small mapping move" |

## Constraints

- ADR 0003 provenance: agent-drafted structure changes go through Proposal;
  the applier is the only writer.
- ADR 0011/0012 aggregation: the Projects module keeps consuming domain state
  through registries; the Room agent context assembly does likewise.
- No new chat system, no routing changes, no runtime work: Rooms' existing
  per-speaker binding resolution stands.
- `.agent/architecture/` docs are updated in the same change that lands each
  phase.
