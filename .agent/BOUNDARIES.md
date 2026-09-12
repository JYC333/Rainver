# Architecture Boundaries

Load this file for any task that changes structure, models, APIs, or agent behaviour.

---

## Data Boundaries

**B1** — The source repository must remain open-source-ready. It must not contain private instance data, real user memory, secrets, or deployment-specific config.

**B2** — Deployment-specific state lives under `RAINVER_ROOT` (host parent of `dev/`, `test/`, `prod/`) and the running instance root `RAINVER_HOME`: database, logs, config, secrets, storage, cache. It is never committed to source control.

**B3** — One deployment instance can host many spaces. Do not create one instance per user or one instance per space.

**B4** — Space is the product-level isolation boundary. Data in space A must
never be accessible to code running in the context of space B. The sole
content-bearing exception is ADR 0013's enumerated, user-centred `/me/retrieval*`
path: it has no request-Space authority, applies each source Space's read gate
independently, persists retrieved content only as re-authorized pointers, and
grants no write authority to another Space.

**B5** — `space_id` is required on every core data entity. Runtime Context acquisition and Delivery persistence require an explicit Space and reject cross-Space authority drift.

---

## User / Agent Boundaries

**B6** — User and Agent are separate models. A user is a person; an agent is an AI runtime. One user can own multiple agents.

**B7** — Users and agents have independent identity, permissions, and memory policies. Do not merge them into a single model.

**B8** — Agents can be user-owned, space-owned, project-owned, or system-owned. Project Folder selection is an execution input, not an Agent ownership class. Ownership affects visibility and permission inheritance.

**B8A** — Room speaking and execution identity is resolved per message. A
Room's creator and a task group's `manager_user_id` are lifecycle provenance,
not authority to substitute one human's retrieval visibility or CLI
subscription for another's. Each Room message creates its own collaboration
task and its Runs carry that message sender as `instructed_by_user_id`.
Room creation requires Project writer authority, every human roster member
must currently be able to read that Project, and revoking Project access also
revokes Room and Room-task reads. Room Run artifacts and proposals cannot widen
past the Run's `selected_users` boundary: they inherit the active Run grants
and remain subject to the Project ACL on every read.

---

## Memory Boundaries

**B9** — Memory is scoped long-term context, not raw business data. Raw input must enter `activity_records` first.

**B10** — The proposal applier is the only writer of active memory. An Agent's memory write applies directly only when it is a new version, carries full provenance, comes from a `manual`-origin session, and changes no reach — no wider visibility, no higher sensitivity, not about another person, not replacing human-authored content. Any write that changes reach, and any write from an unattended origin, is a proposal a person approves, **with one named exception: an Agent's persona entry**, below. Agent Memory (`scope_type = 'agent'`) is the Agent's own: `agent_id` owns it, a note carries the Room it was learned in — null only when the Run speaks in no Room and the person who set it going is the Agent's owner, which is the direct-chat case — and is delivered only to an audience that Room's active human members already contained, and widening a note means promotion to Project Memory as a proposal. A persona entry has no origin Room and is delivered everywhere by design, so it inverts the origin test for the reason ADR 0003 §5 and ADR 0017 §1–§2 give — a `manual` turn proposes it and only the Agent's owner may accept, and unattended work the Agent's **own owner** set going applies it, recorded for the owner with what it replaced and reversed in one step, while work anyone else scheduled is a proposal for the owner like their turn would be — and it is the only place that inversion holds; ADR 0003 §4 records the residual Room crossing that follows as accepted and bounds it there. There is no cap on how much may be remembered — the volume mechanism is a circuit breaker that pauses one person's writing in a session and raises it as a fault, never a queue of writes to approve. Memory is never a black box: every entry shows its provenance and version chain, and a person archives or restores their own directly, without a proposal.

**B11** — Successful reads of registered content are written to
`content_access_logs` only when the viewer differs from the resource owner.
The resource owner is the only default reader of that log. Audit records can
feed health experiences, but never bypass domain read/write governance.

**B12** — External chat capture (e.g. conversation imports) must create activity records first, not active memory.

## Digest / Interest Boundaries

**B54** — Serendipity feedback must never write back to the interest profile.
The material the serendipity section surfaces is low-interest by construction,
so any feedback path from it into interest weights or coverage shrinks the
quota monotonically until the reader is back inside the bubble — and nothing
looks broken while it happens. Serendipity feedback may drive only rotation
cooldown on the surfaced domain and the reader's manual blocklist. The interest
profile and the serendipity quota are two states that never write to each
other. `server/src/modules/interestProfile/` must not read serendipity signals.

**B55** — Serendipity gaps are computed against the code-owned domain skeleton,
never against the reader's own coverage distribution. With their own history as
the reference frame, "not yet encountered" can only be drawn from material their
own sources already surfaced, and the source pool is itself a product of their
interests — so the ceiling is the bubble the mechanism exists to break. The
skeleton's independence from the reader is the property that makes it work, and
is also why cold start needs no special case.

**B56** — Per-user reading state leaves the individual only as an anonymous
aggregate. Raw per-user reading records must not enter any shared read model,
digest, or team report.

## Relationship / Provenance Boundaries

**B12A** — Route durable links by meaning and endpoint shape:

| Link meaning | Canonical writer/table |
|---|---|
| Both endpoints are `space_objects` and the edge is part of the durable graph | `object_relations`, owned by the `ontology` module. Governance is declared per link type **and endpoint pair**, not per table: `supports` between two Threads is direct-write working structure, while `supports` between two Claims is a reviewed assertion ([ADR 0012](decisions/0012-ontology-ownership-and-language-alignment.md) decision 3, amended) |
| Curated KnowledgeItem/Claim citation or supporting evidence | `knowledge_item_sources` / `claim_sources`; citation lineage is not a canonical semantic graph edge |
| Accepted asymmetric lineage with a non-object endpoint | `provenance_links`, or the owning domain's dedicated `*_sources` table |
| MemoryEntry-to-MemoryEntry semantic relationship | `memory_relations`; its relation vocabulary is frozen and must not expand into general provenance |
| Candidate/context Evidence association | `evidence_links`; it is not accepted provenance or the canonical object graph |
| Working-note navigation | `note_links`; it is a UI link, not canonical graph authority |
| Relation-card source citation | `relation_source_links`, with exactly one activity, SourceItem, Evidence, or external target |

Do not dual-write the same semantic edge to multiple tables. Do not add another
generic relationship/provenance link table; extend the canonical table or add
a narrowly owned domain join table only when its lifecycle is genuinely
different. A join table whose columns and vocabulary duplicate
`object_relations` does not qualify — differing endpoint tables is not a
lifecycle difference.

**B12B** — Polymorphic link rows are not proof that an endpoint still exists.
Every writer validates endpoint space/access through the owning module, and
every reader must tolerate deleted or inaccessible endpoints without treating
the link as canonical object existence.

---

## Ontology Boundaries

These invariants are accepted in
[ADR 0012](decisions/0012-ontology-ownership-and-language-alignment.md) and
[ADR 0011](decisions/0011-inquiry-domain-model.md), and are enforced in code as
of 2026-08-05 — the pre-migration shape is gone. `test/ontologyRegistry.test.ts`
and the `space_objects` writer guard are what keep them enforced; a new domain
joining the ontology registers into the same registries rather than
re-implementing the rules.

**B12C** — Within a domain that participates in cross-domain semantic
relations (ADR 0012 decision 4), a table becomes a `space_objects` row only
when it is an **aggregate root**: it has independent identity, is referenced by other
domains, or needs its own visibility. Revision histories, event streams, typed
state rows, per-user working state, and internal configuration are not objects
— they are internal structure of an aggregate and stay domain-private. Project
domain aggregate roots (Inquiry Thread, Experiment, Decision Case) are
`space_objects` rows; their internal tables are not.

**B12D** — A field belongs on `space_objects` only if a **cross-domain
mechanism reads it**. "Every domain has this field" is not a reason. The root
carries identity, visibility/access level, ownership, project scope,
created-by provenance, and archive/delete timestamps, because the read gate,
retrieval, graph projection, and provenance queries read them. Domain
lifecycle state (`status` and its state machine) belongs to the owning
extension table.

**B12E** — The root is ignorant of its subtypes. `space_objects` must not carry
constraints, defaults, or predicates that branch on `object_type`. A change
that requires editing a root-table constraint to add a domain is the signal
that the field is misplaced under B12D.

**B12F** — Behaviour-determining ontology definitions live in **code**:
`object_type`, `link_type`, per-link-type governance level, endpoint
constraints, and interface declarations. Each requires an implementation to
honour it, so it is declared in a registry that modules — including plugins —
register into, not in per-space data. Presentation- and
organisation-determining definitions live in **data**: `object_profile`, field
schema, UI config, retrieval policy, and relation hints. Their absence
degrades presentation; it must never produce incorrect behaviour. Closed-set
validation is the registry's job; the database keeps only format constraints.

**B12G** — Participation in a cross-cutting mechanism is declared as an
**interface** in one registry (`ContentAccessible`, `Retrievable`,
`Graphable`, `Evidenceable`, `ContextIncludable`, `CardSourceable`,
`ProvenanceSourceable`, `Governed`). Its subject is
an **Entity** — `space_objects` subtypes and independent roots such as `run`,
`proposal`, `artifact`, `activity_record`, and `task` alike; unification never
requires a domain to become a `space_objects` row. Each interface states its
own declaration granularity: `ContentAccessible` is declared once for
`space_object` and covers every subtype, `Retrievable` is declared per
`object_type`. **Do not add a parallel per-mechanism type list.** Every
declared interface must have an implementation, asserted by test.

A client-facing copy in `packages/protocol` is the one sanctioned duplicate:
the registry is server-side and holds SQL (table names, status columns, access
predicates), which the client-facing package must not import. The copy is
allowed **only with a server-side test pinning it to the registry** —
`NOTE_LINK_TARGET_TYPE_VALUES` and `NOTE_PROJECT_ROLE_VALUES` are the pattern.
A copy without that test is a violation, not a shortcut: a hand-maintained list
drifting from its backend is the defect this section exists to prevent, and the
test is the entire difference between a projection and a fork. Prefer no copy
at all where protocol already owns the declaration — the Note selection bar
reads `systemActionsForObjectType` directly and keeps only its own wording.

**B12I** — The `ontology` module owns the ontology's own definitions and
storage: the Object Type / Link Type / entity registries and their interface
declarations, registry-backed validation, polymorphic status resolution, and
the `space_objects` / `object_relations` / `space_object_profiles` reads and
proposal writes. It does **not** own the tables of the domains that register
into it — those modules register their own entities and supply their own
implementations, as with `ProposalApplierRegistry`. `ontology` must never take
ownership of a domain table merely because that domain is registered.

Where a shared concern genuinely spans both — proposal creation, Claim lookup —
it is passed in as an explicit seam rather than duplicated or absorbed, so the
dependency direction stays visible.

**B12H** — Ontology objects owned by a Project carry a non-null
`primary_project_id`. The content read gate's scope predicate treats a null
project as "no Project restriction", so a null value silently bypasses Project
membership. This cannot be a root constraint — it would have to name which
subtypes are Project-owned, and B12F forbids the root from branching on
`object_type` — so it is enforced at the single write path below, with a test
asserting no second write path appears. Any projection over `object_relations`
must not expose pre-filter counts or near-miss signals for edges whose
endpoints the viewer cannot read.

`space_objects` rows are written **only** through `db/spaceObjectWriter.ts`,
which is where these creation-time rules live: `requiresProjectScope` per
entity, validated `visibility` / `access_level` (defaulting to `space_shared`),
title truncation at the column width, at least one of user / agent / run
provenance, and a registered ontology `object_type`. A rule enforced at eleven
call sites is a rule that will be missed at the twelfth, and the miss is silent
— it produces an object readable by the wrong people or traceable to nobody. A
guard test fails if any other code writes the table. Reads follow the same
shape: a visibility rule applied to a list route and not to the shared
single-object lookup behind the mutations is not a rule, because a caller can
then mutate what it cannot see.

---

## Execution Boundaries

**B13** — Every file-capable runtime-adapter invocation crosses the typed host
daemon boundary. Callers may send runtime/adapter/workspace identifiers, an
argv the control plane rendered from an adapter spec, and an isolation policy —
never a host path, an image, or an ambient environment map, and the daemon
resolves the executable from the copy it installed rather than from the frame.
Deterministic Verification Engine checks use the
separate `command_run` frame: it carries a server-defined command and one
workspace identity, with no shell, no ambient environment, no provider channel
and a minimal environment. Strict commands have no network; trusted commands
retain native network access. The C3 conformance suite that also used this
path is retired (2026-09-09): a one-shot behaviour probe of a vendor CLI,
cached against a version key and blind to the model actually selected, was not
evidence a dispatch gate could rest on, and what it stood in for — a Run that
cannot reach past its workspace — ADR 0016 made structural.

**A verification recipe is code, and it runs on the host that holds the
workspace.** Its argv comes from a `ValidationRecipe` or a Task's acceptance
criteria — both authored by Project writers — so dispatching a Task to a paired
host runs a Project writer's command on the owner's machine. On the built-in
host the per-Run namespace bounds it; on a paired host it runs natively, which
is the same trust that host's owner already extends to Runs dispatched there.
Say so where a recipe is authored; do not treat a recipe as inert data. A strict host constructs an empty-root namespace per request
and fails closed on workspace, namespace or connection failure; the application
server has no subprocess fallback and no vendor CLI of its own.

**B14** — Runtime Context Delivery is the only model-visible context input for
a Run the server executes in-process. A Run handed to a host daemon — every
CLI runtime, on the built-in host as much as a paired one — uses ADR 0016's
prompt plus work-surface delivery without server-brokered Runtime Context, and
pulls what else it needs through the `rainver` command. The distinction is the
runtime, not the machine: a runtime with a subprocess can pull, and one the
server calls itself has no process to pull with, so its context is assembled
and pushed. An in-process adapter may not use the daemon exception. Adapters may render an accepted Delivery at
their invocation boundary but must not fetch, reorder, rebudget, cache, or copy
it into vendor context files. Vendor control files used solely to disable an
unsupported runtime feature may exist only in the private execution sandbox;
real Project Folder files such as `CLAUDE.md` and `AGENTS.md` are never runtime
context outputs or sources of truth.

**B15** — Formal agent runs (automated, tracked, sandbox-enforced) must go through Rainver managed mode. IDE plugin usage is assist/manual mode — it is not tracked the same way.

**B16** — The control plane runs on Linux/WSL/server. A personal desktop may
serve as a trusted execution host under ADR 0016, subject to supported host
platforms; it is not another control plane. A native desktop app is a
launcher/control panel. See [ADR 0005](decisions/0005-desktop-runtime.md).

---

## Project Folder Boundaries

**B17** — Project Folder file access must go through `PgProjectFolderRepository` / `PgRunSandboxManager` and `PathPolicy`. Adapters must not access arbitrary host paths.

**B18** — Sandboxes are short-lived execution areas. Long-term records are: artifacts, diffs, logs, and approved proposals. Sandbox directories may be cleaned up after artifact collection.

**B19** — Agents do not directly modify a server-host real checkout. Read-only work uses an OS-enforced `read_only` namespace; mutation uses `logical Project Folder → server WorkspaceLocation → git worktree/sandbox → agent execution → validation → diff/artifacts → approval → apply patch`. **Amended 2026-08-21 ([ADR 0016](decisions/0016-control-plane-execution-hosts.md)):** this governed sequence describes the server host and any host under code-patch proposal governance. A Project Folder's remote trusted WorkspaceLocation is the deliberate exception — the agent runs in-place on the daemon-owned directory and there is no worktree/apply-patch stage; see B65.

**B19A** — Files & Code reads are policy-gated. `project_folder.read` is enforced for tree, file, git status, and git diff. Protected-Folder, external-root, restricted/protected, full-diff, and secret-like reads force durable audit records.

---

## Capability Boundaries

**B20** — Capability changes require the full lifecycle: draft → proposed → testing → approval → enabled. Self-evolution (an agent modifying its own capabilities) must go through this flow via capability proposals.

**B21** — Capabilities are code-defined (manifest + code + prompts + tests), not only prompt-defined. A capability without tests or a manifest is incomplete.

**B21A** — Open Skill imports are untrusted external packages whose approved,
immutable snapshot remains the source of truth for that package's procedural
content. Rainver may fetch, inventory, hash, risk-scan, review, bind, pin,
and deliver package files, but it must not canonically re-represent their
instructions, execute scripts, install dependencies, load server/plugin code,
write active memory, or auto-enable a capability. Vendor declarations of tools,
hooks, scripts, dependencies, or MCP servers are requests only and grant no
callable or execution authority.

**B21B** — Runtime skill files for Claude Code, Codex, `model_api`, and future
runtimes are generated adapter artifacts, not a second content authority.
Rainver owns package provenance and snapshot identity, trust and policy,
scope/Agent binding, pinned-version selection, runtime compatibility, Runtime
Context Delivery authorization, and audit. The current normalized conversion,
CapabilityDefinition, profile, binding, and rendering paths are transitional
implementation state and must not be extended as the target skill model.

---

## Frontend / UI Boundaries

**B23** — The frontend is not an admin-only console. It is the primary user-facing product surface including personal use (capture, review, knowledge reading, assistant chat). Design for non-technical users.

**B24** — Raw capture inputs (quick thoughts, inbox drops, file imports, chat captures) must enter via `ActivityRecord` first. Editor-owned user documents such as Notes and diary entries are durable product documents, not raw input records, and may write their owning domain tables directly. Any extraction from those documents into Memory, KnowledgeItem, Runtime Context acquisition, or FlashCard must still go through the proposal/sources flow. KnowledgeItem rows must not automatically enter Memory or an accepted Runtime Context Delivery.

**B24A** — The Activity Inbox holds pointers, never content. Any module that wants user attention delivers a clearable notification row into `ActivityRecord`; the content itself lives in that module's own reading surface (e.g. Sources-derived digests read in Library, not in Inbox). Inbox rows disappear when handled; the underlying content stays where it lives and remains revisitable from its owning surface.

**B25** — Files & Code (file browser, diff viewer) is for Project Folder operators. It must not be shown as the primary entry point for personal-use features (capture, review, chat).

**B26** — Git diff review is approval-oriented, not merge-tool-oriented. The UI must show attribution (which agent run produced the diff) and make accept/reject the primary actions. Inline editing in the diff view is not supported in v1.

**B27** — Server status (RuntimeStatusBar) must always be visible in the shell. It must not be hidden behind a settings page. Degraded/error states must be immediately apparent to the user.

---

## Execution Host Boundaries

See [decisions/0016-control-plane-execution-hosts.md](decisions/0016-control-plane-execution-hosts.md).

**B62** — An instance is one control plane plus N execution hosts, modeled as
Machine → ExecutionHost → WorkspaceLocation → logical ProjectFolder. There is
**one** execution host implementation — the `rainver-host` daemon — running in
one of two trust modes, chosen at registration and never per Run. **Strict**
is the instance's built-in host, the daemon inside the `sandbox-runner`
container: every Run is wrapped in a fresh rootless bubblewrap namespace built
from an empty root and an explicit bind allowlist. The vendor CLI's own
sandbox is *intended* to be relaxed inside it so there is exactly one boundary,
and the daemon does that for Codex by writing `sandbox_mode = "workspace-write"`
into the copy's `config.toml` before spawn. `RAINVER_STRICT_SANDBOX=1` is still
exported for anything downstream that reads it. A
nested vendor sandbox does not fail — that was assumed, never tested, and is
false; it stacks a read-only policy over the Run's own workspace instead
(measured 2026-09-08, ADR 0016 §2) unless that config.toml switch is present. **Trusted** is a paired
personal machine: native process spawn, no namespace, the machine's own login
state (from B68, reached through the Agent's own runtime profile rather than
the machine's `HOME`) unless the Run carries an explicit ModelProvider binding
(see B67). Host liveness and Location `execution_ready` are separate facts,
for the built-in host as much as a paired one — it is a daemon connection, not
an in-process boundary, and must not be reported permanently online. Do not
weaken strict isolation to make the two modes look uniform, and do not claim
trusted execution carries guarantees it does not have. The daemon protocol is
the only execution path and there is no other: the sandbox line
(`sandbox/runner.mjs`, `modules/sandboxRunner/`, the server-side vendor CLI
adapter) is deleted. Do not add a second one — an in-process CLI spawn, a
per-runtime tunnel, a container-per-Run — without a decision superseding this.

**B63** — Two safety models, one per trust mode (ADR 0016 §3). A **paired**
host accepts Runs and serves live Folder reads only for its own registered
owner: there is no multi-user sharing of someone's machine, and a dispatch or
`folder_read` request whose caller is not that owner must be rejected before
any job or read is sent. The **built-in** host has no owner and serves every
Space of the instance: it accepts a Run from anyone with write access to the
Run's Project, and what makes that safe is the per-Run namespace the daemon
builds — not ownership. Do not extend owner-only to the built-in host (it has
no owner to check), and do not extend Space-authorized dispatch to a paired
one (its safety is not a namespace).

Managing a host is a separate question with a separate answer: installing a
runtime on the built-in host, logging a copy in or out, removing or upgrading
one is instance-admin work, because there is one copy per instance and every
Space spends it. Members see what is installed and whether it is logged in,
because that is what says whether their Run can run there at all.

**B64** — The control plane never resolves, mounts, or reads a filesystem
path on a remote host. A remote WorkspaceLocation's `root_path` stays null;
only a daemon-reported `display_path` may be stored, and it is UI-display
data, never used for access control, mount resolution, or identity. A Folder
is logical and may have multiple Locations; no old Folder host/path column may
be reintroduced.

**B65** — Remote in-place execution's propose→apply governance (review before
changes land, rollback semantics) is an open design question, not settled by
default. Do not wire a remote diff into the code-patch proposal apply/rollback
machinery without a new decision superseding this boundary.

**B67** — For a Run bound to a ModelProvider, **backend selection comes only
from what the control plane injects for that binding.** State the rule that
way round: the executing machine contributes nothing to which backend,
credential, or upstream the runtime reaches, and a denylist of forbidden
variable names is not a sufficient reading of it. In scope are both halves of
how a CLI runtime picks a backend:

- **Environment** — vendor key and endpoint variables (`ANTHROPIC_*`,
  `OPENAI_*`), alternate-backend selectors (`CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX` and their cloud credential/region companions), and
  egress variables (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
  and lowercase), which decide where the injected lease token actually
  travels. These are examples of the rule, not its definition.
- **Ambient config and auth state** — the runtime's own on-disk profile
  (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, and a
  runtime's settings file that can itself export environment). Pointing the
  run at a control-plane-provided profile directory is part of the binding,
  not an optional extra, and since ADR 0016 there is exactly one place that
  happens: **the daemon, on the host that runs it**. Nothing on the control
  plane materializes a profile any more — there is no broker temp HOME and no
  server-side sandbox cwd to write into, because a CLI does not execute here.
  The daemon creates a per-(Agent × container × adapter × provider) profile
  directory (B68) and sets every state-root variable the runtime's login spec
  names so the vendor's config resolves inside it, for both host kinds alike.
  The rule that made this necessary is unchanged: forwarding a path the control
  plane knows satisfies nothing, because the control plane knows no host path
  (B64) — profile isolation is established where the run executes or not at
  all.

Two failures this prevents, both silent: a selected provider shadowed by
machine state, so the Run's recorded `model_provider_id` is a lie; and a
subscription login converted into API billing by a leftover key. A Run with
**no** binding is not affected by *this* rule — it keeps using the machine's
own login state and the machine's own environment, including `HOME`, so its
`~/.gitconfig`, `~/.ssh` and proxy variables stay reachable. What it does get
is a **state root** of its own: every host-bound Agent run, bound or not, runs
in a runtime profile keyed by Agent × container, reached through that
runtime's own state-root variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the XDG
roots) rather than by moving `HOME`, with the machine's login linked into it.
That is a memory boundary, not a backend one — see B68. What such a run does
drop is the vendor credential variables **the launched runtime reads** that a
machine may have lying around, for this rule's own second reason: a leftover
key would bill an API account instead of the subscription the profile was just
given. Per runtime, not one list for all, so a Task run on Claude Code keeps
the `GOOGLE_*` variables its gcloud toolchain needs.

Enforcement is the daemon's, on every host, because every CLI run is a daemon
run: its spawn environment and profile-directory selection are the point where
this holds, and they implement it:
for a bound run the daemon rebuilds the environment from an allowlist and
points the runtime at a control-plane-provided profile. A run with no binding
still inherits the machine's environment — minus only the vendor prefixes that
would move a runtime's state root back out of its profile or hand it a
credential the control plane did not choose (B68) — which is the pre-existing
behavior and the default. Neither path may be loosened into
a wholesale ambient inherit for a bound Run. See
[ADR 0008](decisions/0008-credential-channel-isolation.md) for the channel
isolation this protects and ADR 0016's 2026-08-24 amendment for the binding
that makes it reachable remotely.

**B68** — On an execution host, a vendor CLI's own state — its login, its
session store, and whatever it remembers on its own — belongs to **one Agent in
one container**, never to the machine. Every host-bound Agent run, bound to a
ModelProvider or not, runs in a runtime profile keyed
`agents/<agent_id>/<container_kind>/<container_id>/<adapter>/<provider|ambient>`,
where the container is the Conversation for a Room turn, the owner for a direct
chat, and the WorkspaceLocation otherwise. Two Agents on one machine, and one
Agent in two Rooms, share none of it. The machine's login still serves them
all: it stays in one login home per host × installation and is **linked** into
each profile, and the profile is reached through that runtime's own state-root
variable rather than by moving `HOME`, so an unbound run keeps the machine's
git and ssh configuration — never copied, never passed through a subprocess
environment
([ADR 0008](decisions/0008-credential-channel-isolation.md)), and never read by
the daemon. A host-bound runtime whose registry entry declares no login/state-
root boundary is refused: running it in the managed installation's shared home
would violate this boundary, while moving it into an empty profile would break
authentication. Profiles are archived, not deleted, when an Agent
leaves a container, and cleared on demand by
`POST /api/v1/agents/:agentId/host-state/reset`.

This is a *memory* boundary and it is the substrate half of
[ADR 0003](decisions/0003-memory-proposal-flow.md) §6: Rainver owns an Agent's
identity and its distilled Memory, and the CLI's own auto-memory stays
delegated scratch that is never read, synchronized, reviewed, or promoted into
`memory_entries`. Do not confuse it with B67, which is about which *backend* a
run reaches: an unbound run keeps the machine's environment and B67's closing
rule stands, minus the vendor credential variables that would spend an API
account instead of the subscription this profile was given.

## Mobile Boundaries

**B28** — Mobile is a thin client. Agent execution always runs server-side (or, per ADR 0016, on a registered execution host acting on the control plane's behalf). The mobile client must never attempt to run agent code locally.

**B29** — Quick capture on mobile must work offline. The client must queue the ActivityRecord in IndexedDB and sync when the connection is restored.

**B30** — Card review on mobile must pre-fetch the next N due cards so review can continue without a live connection.

---

## Sync Boundaries

**B31** — All model primary keys must be UUIDs (or equivalent globally-unique strings). Auto-increment integer PKs are not allowed — they break sync across devices.

**B32** — Sync must never overwrite user data without explicit conflict resolution. Sync conflicts surface in the UI; the user decides. Memory changes through sync still require the proposal → approval flow.

---

## Resilience Boundaries

**B-R1** — `Run.status` includes `degraded` in addition to `queued|running|succeeded|failed|cancelled|waiting_for_review`. A run is `degraded` when it completes but with partial or compromised quality — the output is accessible but flagged for user review.

**B-R2** — `Run.mode` includes `live` (real execution, persists changes) and `dry_run` (preview, no persistent changes, artifacts not saved).

**B-R3** — Artifact export is explicit: every artifact has `path` and/or `content`; `GET /api/v1/artifacts/{id}/export` returns a file download. Artifact paths point to persistent storage (`~/.rainver-data/artifacts/`), not sandbox working directories.

**B-R4** — `Proposal` has explicit temporal fields: `created_at`, `decided_at`, `deadline` (soft, optional), and computed `expired` (true when deadline passed and status is still `pending`). `urgency` field (`low|normal|high|critical`) affects sort order.

**B-R5** — All temporal fields are explicit on Run: `created_at`, `started_at`, `completed_at`, `scheduled_at`. No derived timestamps.

---

## Module / Plugin Boundaries

**B33** — Server modules should prefer shared gateway/db/protocol helpers over direct cross-module coupling. Cross-domain imports are allowed only when they express an explicit product boundary recorded in the relevant architecture doc or ADR, and they must not bypass the owning module's public route/service boundary. A read predicate that more than one domain needs belongs in `modules/access/`, not in the domain the data is named after: `runReadSql` / `proposalReadSql` / `artifactReadSql` / `runInheritedReadSql` are read by tasks, projectWork, agentGroups, sources, plans and frontendSupport, and each of those importing them from `runs` would be exactly the coupling this rule exists to prevent. The canonical `runs`, `proposals`, `artifacts` and `projects` repositories still compose the same pair by hand beside their own predicates rather than calling these — recorded at the helpers' own definition, and the reason a term added to one of them does not yet reach every reader.

**B34** — Every server module's HTTP routes must live in `server/src/modules/<module>/routes.ts` and be mounted through `server/src/gateway/routeRegistry.ts`. Official plugin package routes live under `plugins/official/<plugin_id>/server/src/`, are compiled into `server/dist/official-plugins/<plugin_id>/`, and are mounted only through `PluginHost` after core `SERVER_MODULES` and before the catch-all. Routes must not be registered directly in `server.ts`, `index.ts`, or ad hoc shared API files.

**B35** — The server route registry (`server/src/gateway/routeRegistry.ts`), official plugin descriptor registry (`server/src/modules/plugins/registry.ts`), official plugin package loader (`server/src/modules/plugins/builtInPlugins.ts` and `server/src/modules/plugins/packageLoader.ts`), and frontend module registry (`apps/web/src/modules/registry.ts`) are the single sources of truth for which core and official optional features are active. Official plugin frontend page source lives with the plugin package under `plugins/official/<plugin_id>/web/src/`; it must not import `apps/web/src` directly. The frontend registry statically imports an app-owned adapter under `apps/web/src/plugins/<plugin_id>/` that injects host APIs into the plugin page until remote frontend bundles exist. Do not hardcode route lists or nav items elsewhere.

**B36** — Frontend module pages must use `React.lazy()` entry points. A module must not be eagerly imported in `apps/web/src/App.tsx` or `apps/web/src/core/Shell.tsx`. This preserves Vite's ability to produce separate chunks per module for build-time exclusion.

**B37** — `planned: true` modules must have a working stub page (not a blank component, not a 404). The stub must name the feature, state that it is planned, and reference the relevant `.agent/modules/` doc.

**B51** — Official optional modules are gated at the route-handler/contribution level via the plugin guard (`requireOfficialPluginEnabled()` or `ctx.http.pluginGuard()`), not by conditionally registering core server modules. Backend routes for bundled official plugins are mounted by `PluginHost`; behavior is gated by DB-backed plugin enablement state. Plugin job handlers and proposal appliers must fail closed when disabled, and scheduled tasks must fan out only to enabled scopes. Frontend entries with `source: 'official_plugin'` must overlay their `enabled`/`visible` state from `GET /api/v1/plugins/effective`, not from static values.

**B52** — Capability (`catalog/capabilities/`) and Official Optional Module (`/api/v1/plugins`) are distinct concepts and must not be conflated in code, comments, or API design. Capabilities are agent AI skill descriptors; Official Optional Modules are product feature packages. A module may use a capability internally, but they are not the same type.

**B52A** — Open Skill, Capability, Capability Pack, Runtime Skill, and Product
Plugin are distinct concepts. External Open Skill packages can be normalized
into capability candidates; Capability Packs group capabilities; Runtime Skills
are generated runtime bindings; Product Plugins are optional product feature
packages. Workflow Template was a sixth concept here until the
capability-shrink plan deleted that layer; an enforced process is a Workflow Definition, which is
execution-engine data rather than a capability grouping.

**B53** — Plugin settings and enablement state must be scoped exactly as declared in the descriptor's `scope` field: `space` uses `(plugin_id, space_id)` and requires space owner/admin for writes; `user` uses `(plugin_id, user_id)` and follows the user across spaces. Space-scoped plugin state for space A must never be readable or writable in the context of space B, and user-scoped plugin state must never be readable or writable by another user. The plugin guard must check both plugin existence and descriptor scope.

---

## Runtime Adapter Boundaries

**B38** — The Rainver core is runtime-agnostic. OpenCode, Claude Code, Codex, Cursor, and any other vendor CLI are optional runtime adapters, not the foundation. Core features (memory, knowledge, flashcards, activity capture, proposals, assistant chat) must work without any coding-agent runtime installed.

**B39** — No vendor CLI or external runtime is the source of truth for memory, policy, permissions, or audit records. These always live in the Rainver database regardless of which runtime adapter is active.

**B40** — An enterprise or commercial deployment must be able to disable any runtime adapter (for example `claude_code`) without breaking the rest of the system. Adapter availability is checked at run time via runtime-generic status/detection; unavailability must be surfaced as a clear error, not a silent fallback to unsandboxed execution.

---

## CLI Credential Boundaries

**B45** — A vendor CLI's login belongs to the copy that holds it, on the
execution host that runs it (ADR 0016 §7). Rainver stores no CLI credential,
resolves no path to one, and mounts none into anything. A Run dispatched to a
host names the host and the installation; whatever that copy is logged into is
what it uses.

**B46** — A CLI runtime profile that names no execution host is not a runnable
backend. There is no server-side copy of a vendor CLI to fall back to, so such
a profile is filtered out of conversation backends and marked
`credential_available: false` in routing rather than dispatched to a machine
that would use its ambient login.

**B47** — What the control plane learns about a CLI's login is exactly: whether
it exists, the account ids and kinds a multi-account CLI reports, and
subscription percentages with reset times. Never the credential, its contents,
or its path (B64). The host reads it, spends it against the vendor's own
endpoint, and returns numbers.

**B48** — A managed adapter's login, native history and user configuration live
in its stable host-local HOME, outside versioned program directories. Upgrade,
reinstall, rollback, pruning and binary removal preserve that state; rollback
changes binaries, not user data. The machine's `own` CLI and other adapters or
hosts remain separate. Credentials never travel through the server; this is
local continuity of one managed installation.

**B49** — No API of Rainver's returns a runtime credential's value, and none
returns a path to one. A managed subscription reports connection state and
quota; a host's copy reports whether it is logged in, which accounts it holds,
and what its subscription has left. Nothing else about either crosses an API.

## API Entrypoint Boundaries

**B50** — `server/` is the TypeScript backend source root. The Compose/API
entrypoint service name remains `server` for web, dev, test, and prod.
The permanent gateway module owns routing and request context; unknown
`/api/v1/*` routes fail closed with the local 404 catch-all. Schema authoring
goes through Drizzle definitions under `server/src/db/schema/`; generated SQL
artifacts live under `server/migrations/` and are applied only through the
explicit server migration runner. Do not hand-edit migration SQL for schema
changes. The server service process does not auto-migrate on startup.
DB-persisted API-key storage remains disabled/deferred until the canonical
schema adds that table.

**B66** — A new Agent entry point (HTTP route, tool surface, managed-loop
surface, or any future host) is a thin adapter over `SystemActionDispatcher`
(`server/src/modules/systemActions/systemActionDispatcher.ts`). It may
translate transport-specific request/response shapes and assemble which
actions to expose, but it must not itself decide grants, evaluate policy,
mutate a domain table, or otherwise define action semantics — that belongs to
the single `SystemActionGateway`/`SystemActionDispatcher` path
(`CliAgentToolTransport`'s Run-scoped REST tool surface and
`ManagedAgentToolSurface`'s managed model loop both call it directly).
Runtime delegation materialization
(`AgentGroupRuntimeDelegationMaterializer`) is a documented exception, not a
model to copy: it runs after the Run has already terminated and so cannot go
through a run-scoped dispatch, but it still independently enforces the same
grant rather than skipping the check. See
`.agent/architecture/SYSTEM_ACTIONS.md`. A coding agent adding a new surface
must reuse the Gateway/Dispatcher path rather than building a second tool
system, and any surface that genuinely cannot call `SystemActionDispatcher`
must still enforce the same grant and policy checks itself, not skip them.
For Path B specifically, an ungranted delegation must leave a completed
denial audit event; an admitted delegation must leave the normal invocation /
completion pair.

---

## Deployment Boundaries

**B41** — The main app container does not directly restart or rebuild itself, and the server never holds Docker authority. A product deployment trigger is a job record the server stores and the privileged deployer *pulls* over the internal-token channel; the server never pushes into the deployer and never executes deployment steps itself ([ADR 0020](decisions/0020-instance-update-through-deployer-pull.md)). Both halves exist: `deployment_jobs` with its append-only stage events, admin routes under `/api/v1/deployments/`, and internal routes under `/internal/deployment/` that only the internal token reaches; the deployer's pull loop claims a queued job on its heartbeat and reports each stage back. An update is refused outside production, where images are built from a checkout the sidecar does not mount. Explicit operator execution of the allowlisted scripts remains a separate, unchanged trigger.

**B42** — The deployer Unix socket is never exposed on TCP and remains private to the privileged deployer container. It must not be placed in `RAINVER_HOME`, mounted into the server container, or made reachable from an agent runtime or sandbox. Filesystem permissions are defense in depth, not an approval mechanism.

**B43** — The deployer's Unix socket accepts exactly `rebuild_rainver`, `restart_rainver`, and `health_check`; its pull loop accepts exactly `update` and `check_update`. None of these jobs accepts request arguments. The deployer never accepts arbitrary commands, request-to-environment overrides, self-evolution jobs, code-patch jobs, capability jobs, caller-selected script paths, image tags, or channel changes. A deployment job may be created only by the instance administrator through an authenticated admin route; that request is the per-instance human approval ADR 0017 §1 requires for deployment, and the job row with its stage events is the durable audit. No Proposal applier, Agent, automation, job, or scheduler path may create one. The deployer never writes the instance `.env`; channel selection and rollback are host operations.

**B44** — The deployer container's Docker socket is host-equivalent authority. Its repository mount is `ops/`, read-only — the compose files and ops scripts the deployment steps read, and no writable checkout. The instance mode root is mounted at its host path so that client-side Compose reads and daemon-side volume sources name the same directory, and the container never edits the instance `.env`. Nothing on the evolution, `code_patch`, capability, agent-runtime, automation, job, or scheduler path may reach deployer input or invoke its scripts. The update job recreates `server`, `frontend`, and `sandbox-runner` only; the deployer never recreates itself. CLI execution is a separate run path entirely: the `rainver-host` daemon inside `sandbox-runner`, isolating each Run in its own bubblewrap namespace, reached over the host WebSocket. It is never routed through the deployer protocol and never given deployer input.

**B44A** — An Rainver instance must never be directly exposed to the public internet. The current frontend has no production TLS termination, rate limiting, or general CSRF-token hardening. Any move toward internet exposure must first implement and review those controls and update the security boundary documentation.

---

## Change Convention Boundaries

**B58** — Do not introduce compatibility aliases or dual authorities. When a
concept is renamed or replaced, the old name is removed in the same change. Two
names for one thing, or two documents claiming the same authority, is the defect
this rule exists to prevent — not a migration convenience.

**B59** — `server/migrations/` is an append-only chain. `0000_baseline.sql`
is frozen (a deployment has carried data since 2026-09-06), and every schema
change after it is a new numbered file appended by
`pnpm run schema:generate -- --name <name>` from the Drizzle schema, with data
backfills written into that same file. A migration that any database has
applied is never edited, renamed, or removed — the runner records checksums
and refuses a changed one, and `baselineSchema.test.ts` pins the baseline's
hash. Do not fold a change into an earlier file, and do not add compatibility
shims in application code for a shape a migration has already replaced. A release's
migrations run while the build they replace is still serving (ADR 0020 §5 puts
`migrate` before `recreate`), so each one must leave the schema readable by the
previous build — expand in the release that needs the new shape, contract in a
later one. That is a constraint on what a single release may drop or rename, not
a licence for compatibility code: B58 still applies to the application.

The exception is an **offline maintenance migration**, and it is marked as one:
`-- rainver:maintenance` on a line of its own within the first 20 lines of the SQL file. Such a
migration removes something the running release still reads, so `start.sh` and
the deployer's UI update both refuse it and name
`./ops/scripts/start.sh --maintenance`, which stops the applications, takes the
dump, and applies it with nothing reading the old shape (ADR 0016 §10).
The distinction is compatibility with the running version, not whether a
database changes: an ordinary migration that adds a table stays installable
from the UI. Reach for the marker only when expand-then-contract cannot be
split across releases; a maintenance upgrade is downtime someone has to
schedule.

**B60** — Internal UUIDs remain valid storage and transport identifiers. Users
never type them in normal product flows, but that is a UI requirement, not a
reason to invent a second identifier scheme.

**B61** — Implementation functions and tests use domain names, never `phase1`,
`phase2`, `phaseX`, or similar migration-stage names. A plan's phase numbering
is scheduling vocabulary and must not outlive the plan by being written into
code.

---

## Open-Source Boundary

**B70** — (ADR 0017) A write is gated behind per-instance human approval only when it is self-modification, a long-term belief that widens reach, a real-checkout change, an exposure change, money above a bounded default, a credential or deployment change, or the Project's direction — and the action's registration names which. Every other Project-internal write is governed by trigger origin (`manual` executes; anything unattended is `require_approval`), with one exception — an Agent writing its own persona on an `agent`-scope entry, a first one as much as a revision, which is governed instead by ADR 0003 §5 and named in B10 — and by bounds set before the work runs (fan-out ≤ 5 per turn as an execution ceiling, with the narrower conversational pacing of ADR 0019; spend at the pipeline's bounded default, the remainder offered once), with review-after: every such write is in Updates with undo, and attention carries only what a person must decide. A default may flip from proposal to direct only after the review it displaces exists.

**B22** — The project is open source. Do not put private data, real user memory, or non-shareable credentials into the source repository; see B1/B2.
