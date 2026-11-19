# Module: Runtime Context

Runtime Context is the single authority that turns a physical model invocation
into an authorized, budgeted, immutable Delivery. Managed adapters, direct Chat,
Room turns, and local CLI adapters all enter through
`RuntimeContextInvocationGateway`; they do not assemble context themselves.

## Ownership

`server/src/modules/runtimeContext/` owns:

- typed acquisition from the Run, execution-control snapshot, Work Context,
  canonical messages, checkpoints, and Retrieval authority;
- deterministic normalization, precedence, deduplication, budget planning, and
  managed/CLI rendering;
- immutable Invocation Delivery and safe Invocation Snapshot lifecycle;
- scope-sequenced Context Events, capture gaps, Micro Checkpoints and
  corrections — an audit ledger, read by Context Ops and the history tools.

Canonical bodies remain in their owning domains. Runtime Context persists refs,
delivery evidence, safe projections, and continuity state; it is not a second
Memory, Message, Project, Policy, or Retrieval store. Retrieval authorization
stamps each item's `owner_user_id` and visibility from the canonical source so
`context_taint_json` can require contributing-owner egress review.

## Invocation contract

For each physical provider or CLI call orchestration supplies an invocation id,
the instructing user and Space, a `TurnContextRequest`, the immutable
execution-control snapshot id, adapter/provider/model identity, and a unique
Usage source id. `prepareInvocation()` reacquires and reauthorizes live inputs,
plans a `RuntimeContextEnvelope`, authorizes it against the control snapshot,
and persists one accepted `InvocationDelivery` plus its safe snapshot draft.
Delivery includes an optional numeric `context_estimate` projection of the
accepted allocation buckets for usage diagnostics; it is not another planner.
CLI aggregate usage cannot measure the input size of a single Delivery, so its
Snapshot `actual_tokens` and window reconciliation remain unmeasured instead
of recording only uncached input as the actual size. Cumulative measured
buckets and the runtime's last occupancy report remain in the usage record.

The adapter may only render the accepted Delivery. It cannot fetch additional
context, reorder items, change precedence, rebudget, or reuse a Delivery for a
different physical call. It acknowledges delivery and finalizes the invocation;
tool loops prepare a new Delivery for every physical provider request.

An explicit native ACP model selection is read from the Run's session config
before planning and recorded on the Delivery. ACP config options do not report
model context limits, so every runtime-native ACP session uses a null window
(`acp-runtime-managed.v1`) instead of a guessed 16K limit or per-model Rainver
exceptions. Required and pinned content remains intact; optional ranked content
has a separate 16,384-byte-estimate budget. A ranked item that does not fit is
cut to the remaining budget: conversation continuity keeps its end (the turns
just before the current message), anything else its beginning, and at equal
rank continuity is placed before a retrieved hit. The CLI enforces its actual model
limit and any rejection is surfaced as a runtime error. A Profile bound to a
Rainver ModelProvider uses the shared model catalog and its numeric window
plan, including the conservative unknown-model fallback.

The Delivery renderer keeps delegated instructions and reference data before
user input, and places the current message last even when a Room recipient
instruction is another `user_input` item. The ACP adapter preserves that
Gateway-owned order.

For an ordinary `chat_turn.v1` Run, the current input is the canonical user
message. Acquisition includes that message's text and immutable
`input_resource` descriptors in Delivery. Planning and transaction-time authorization
use the same message renderer; authorization reloads the message-owned descriptors
in the source Space and compares the complete text, including attachment metadata.
A direct-chat message authorizes the Run it started and each retry of that
turn: the retry route reuses the message and records the new Run in its
`retry_run_ids`, which `loadAuthorizedCurrentContextMessage` and the
Gateway's message check both accept. A Room retry reuses its message the same
way. Conversation continuity excludes
the same current message. At ACP dispatch, conversation-input hydration adds
images and resource links, but does not add a second descriptor text block when
Delivery already contains it. The adapter sends Delivery instead of the raw
Run prompt. A session handoff uses its own Run request as current input and
does not hydrate the pending user's message attachments. A delegated child
Run (`runs.delegation_id` set) also uses its own Run request — its delegation
instruction — as current input even though it inherits its parent's
`chat_turn` record: the person's message is the parent's input, and a child
handed it would act as a second coordinator on that message
(`currentRuntimeContextInputRef`). ACP hydration applies the same boundary, so
inherited chat-turn metadata does not attach the parent's images or resource
links to a delegated child's request.

When the current input is a Run request, an identical task instruction is not
also acquired as `run_instruction`. A Room delegation's prompt is assembled
from standing context and a handoff followed by that same instruction, and the
assembling code records `run_request_includes_instruction: true` on the child's
`model_override_json` (`agentGroups/service.ts`, read by
`runtimeContext/runRequest.ts`). Acquisition, delivery revalidation and
canonical Run-request history read that recorded fact; they never infer
assembly from matching text, so a prompt that merely ends with its instruction
keeps both. Distinct instructions remain authoritative and intact.

## Continuity

Conversation and task continuity is an ordered ledger of canonical refs, not a
route-owned prompt cache. Runtime events are append-only per typed work scope.
Terminal events create deterministic Micro Checkpoints. Nothing extracts from
the ledger: there is no semantic-checkpoint job and no provider call behind a
turn (`context_semantic_checkpoints` keeps only rows written before that job
was retired, and the correction route still supersedes one of those). The
ledger is the audited record; it is never replayed into a vendor CLI session,
and the conversation's own summary is the one an Agent writes on request
(`modules/hosts.md`, "Conversation summary and restart"; ADR 0014 §11).

A direct conversation's raw tail follows the canonical visible message path
through the triggering message, including messages whose ledger capture is
still missing. Clock timestamps and delayed event arrival cannot reorder that
tail or admit later messages. A checkpoint excludes only the messages its
ledger prefix actually captured; the prefix ends before any known message
outside the trigger's path. The current message stays available to acquisition
and is excluded from historical rendering.

A Room recipient's Work Context scope is one Conversation with that
recipient: a `room_conversation_recipients` row, created on the first Run that
resolves it (`policy/executionControlSnapshots.ts`) or explicitly configures
its scope, and authorized through the
recipient's Room membership in `workContextService.ts`. Its ledger, checkpoints
and Setup belong to that Conversation alone; another
Conversation's transcript never enters its history (ADR 0014 §11).

Room Runs from before per-Conversation scopes have control snapshots naming
the whole-Room recipient scope. The upgrade split (in `0002_skill_library_and_upgrade_repairs`)
moved their events and capture gaps to the Conversation scopes but
left the snapshots alone, because they are audit records. Continuity therefore
counts a Run as in scope when its snapshot names the scope, or when the scope
is the `room_conversation_recipients` row for that Run's own Conversation and
the snapshot names that row's recipient (`controlInScope` in
`continuity/service.ts`); the canonical-ref checks use this rule. A Run
of another Conversation with the same recipient is still foreign.

A capture gap is recorded with the event it buffered (`context_capture_gaps`,
`replay_event_json`) and the scope stays `partial`. No job replays or
reconciles it afterwards: the ledger is an audit of what was captured, and a
known gap is shown as one rather than repaired later.

## What an ACP Run is sent

The vendor CLI session is the conversation's working memory. The host thread
records which ACP session a Conversation × Agent continues
(`host_threads.vendor_session_id`, `modules/hosts.md`); a Run resumes that
session and its Delivery carries the turn's current input, attachment
descriptors and whatever is this turn's own (a routed segment, a retry note,
a Skill the person selected in the message). The **standing items** — the
Agent's instruction (`agent_version`), the Project Instruction and Brief,
the Skills bound to the Agent or Project, the Room identity block — are sent
into a fresh session and into a resumed one only when their versions changed:
`PgDirectProvider.standingAlreadyHeld` hashes their source refs
(`standingItemsDigest`), using the Agent id and rendered-content hash for the
Room identity instead of its per-Run audit ref. It compares with
`host_threads.standing_digest` for the very session being resumed and records its decision on the Run
(`model_override_json.host_thread.standing_digest` / `standing_sent`); the
thread learns the digest only from a Run that carried them and landed
(`recordRunOutcome`), exactly as the Room identity digest does, so a retry
after a failed turn sends them again into the session that turn opened. A
direct chat's thread has no `space_id` (`ck_host_threads_owner`); this lookup
and Run routing scope it through its Agent's Space instead. No
history, checkpoint or event delta is delivered into a resumed session (the
continuity acquisition returns nothing for a vendor CLI Run,
`productionAcquisition.ts`): the
session already holds the conversation, and every ACP client surveyed (Zed,
JetBrains, Vibe Kanban, Paperclip, Symphony) works the same way. A fresh
session — the first turn, a context reset, a restart from a summary — opens
with standing context and the conversation title, plus the summary the Agent
wrote when it is a restart (`modules/hosts.md`, "Conversation summary and
restart"); nothing of the transcript is replayed, as with a cleared CLI
session. The one exception is a briefing highlight the person attached for
this turn, i.e. after the Agent's last reply. A fresh session gets it as a
required `room_briefing_reference` item: reference data, `external_untrusted`,
the stored copy verbatim. A resumed session reads it in the Room increment.
Either way the planner and the gateway first re-verify it through the Source
egress gate against the Delivery's own destination, which comes from the Run's
persisted adapter and ModelProvider (`runDestination.ts`), never the editable
Profile. The gateway does this after locking the copy's Source closure, held to
commit, and refuses the Delivery otherwise
(`informationDigest/briefing/referenceDelivery.ts`).
`lockBriefingGenerationAuthority` exposes the existing whole-version fence
(briefing row, complete audience, context/signals/grants/subscriptions, canonical
Source item/connection locks) for both physical generation Delivery and R2 theme
publication. Exact original Snapshot/Artifact and strategy-version rows are also
locked. The caller re-authorizes the actual frozen Run destination after locking;
this is not a new grant or a Profile-derived fallback. Publication holds the same
fence to commit, so a canonical Source revocation either commits first and is
refused, or waits for that publication. Original network/model execution still
happens outside the transaction.
Provider-backed continuity is gated the same way for any briefing reference
it replays. The remote Host adapter sends the Work Skill pointer into a fresh
session only; a resumed session already holds it. A resumed turn that
carries only the person's message is sent as that message, verbatim
(`runs/acpRuntimeContextPrompt.ts`). After the Delivery the order is fixed:
Run control, then the person's attachments, then accepted Skill links. Run
control is not a Delivery item: the remote Host adapter composes it from
server-held Run state after the Gateway accepted the Delivery, each entry
tagged with its source (`execution_workspace`, `work_surface`,
`ordinary_tools`), under its own `## Rainver Run control` heading that says it
is not the person's text and grants nothing. Attachments get their own
`## Current user attachments` heading. Every Rainver heading carries a marker
drawn fresh per prompt (`[rainver:<hex>]`), so a message or attached file
cannot imitate a Rainver section; a verbatim message stays the first block.

A Run that parks mid-turn (`waiting_for_dependency` or `waiting_for_review`)
writes the session the runtime reported back to its
`host_thread.runtime_session_id`, so its next attempt resumes that session
instead of the one it was created with. Tool grants, instructions and egress
are enforced per Run by the dispatcher and re-sent through standing context
when they change; none of them rotates the vendor session. The session is
replaced only by the person (a reset, or a restart from a summary), a runtime that refuses
to resume it (`runtime_session_invalid`), or a changed host or working
directory.

### Joined acceptance

`server/test/promptProvenanceAcceptanceDb.test.ts` drives each conversation
path through production on real PostgreSQL — the direct chat and retry routes,
`RoomService` send/retry/summary, and a manager's mid-turn `agent.delegate` —
with the `agent_run` job handler executing every Run. A synthetic daemon on the
Host connection registry (`test/support/syntheticAcpHost.ts`) records the ACP
prompt it is actually sent. For one invocation, `test/support/promptProvenance.ts`
checks that the Invocation Snapshot names the persisted Delivery and exactly
one canonical current input (`currentRuntimeContextInputRef`), that the
prompt's text sections reproduce every Delivery block hash once and in order
with the current input last and present exactly once, and returns the
attachments and continuity facts each path asserts: fresh and resumed direct
and Room turns, an image and a draft `input_resource` (descriptor once, link at
the edge, no body), direct and Room retries, a delegated child and a summary
handoff (own Run request; no parent message, descriptor or image). Component
contracts remain in `acpRuntimeContextPrompt.test.ts`,
`remoteHostCliAdapter.test.ts`, `conversationInputService.test.ts` and
`runtimeContextDeliveryDb.test.ts`.

## Knowledge retrieval switch

Whether a conversation searches the knowledge base on its own is the person's
choice. A direct chat or Room recipient retrieves only when its Work Context
Setup's `retrieval_preferences.enabled` is true, so a new conversation starts
with retrieval off. Root tasks and workflows keep retrieving unless their setup
turns it off. `GET`/`PUT /api/v1/runtime-context/work-contexts/:scopeId/retrieval`
read and set the switch and its `preferred_domains` as the next Setup version
for that person and scope; a direct chat's scope is its session. A Room
Conversation has one shared switch at
`/api/v1/runtime-context/room-conversations/:sessionId/retrieval`, independent
of which Agents are addressed. The session repository stores this preference
in `sessions.metadata_json.knowledge_retrieval`, preserving other metadata;
reads and writes require an active Room member with Project read access.
Reading creates no recipient scopes. Each invocation copies the current
Conversation choice into that recipient's versioned Work Context Setup before
its execution snapshot is frozen. New recipients inherit the same choice;
existing Runs keep their original version. With no explicit Conversation choice,
retrieval is off. Both composers show one short switch without Agent names.
Governing policy can still forbid retrieval.
Both `PUT` URLs, `POST /api/v1/runtime-context/work-contexts` (Setup versions),
`POST .../work-contexts/:scopeId/checkpoint-corrections` and
`PUT /api/v1/runtime-context/policies/:scopeType/:scopeId` are formal adapters
over keyed, strict, human-only core commands (`runtime_context.*`, see
`runtimeContext/operations.ts` and `policy/runtimeContextOperations.ts`). The
owners keep their advisory locks, stale-base checks, governing-policy limits and
own `work_context_setup.change` / `runtime_context_policy.change` decision
records inside the operation transaction; receipts carry ids and versions only
and clients reread the switch, Setup or policy through the GET readers. A
replay is released only while the person can still read that Work Context or
Room Conversation, or still change that policy scope. The Room switch takes
the Room and member rows `FOR SHARE` before writing the session, the order the
Room writers use. Known stale-base, scope and policy-limit refusals are an
explicit message allowlist; any other domain error stays internal.
`POST /api/v1/runtime-context/policies/resolve` is the read-only core query
`runtime_context.policy.resolve`. `POST /api/v1/runtime-context/preview` is the
keyed command `runtime_context.preview.request`: it checks the Work Context is
readable under its lock and commits a single-attempt `runtime_context_preview`
Job (`runtimeContext/previewRequests.ts`), because planning can embed the
retrieval intent and records context-injection reads. The Job rechecks the Work
Context, and its start fence means an unknown outcome is never re-run.
`GET /api/v1/runtime-context/preview-requests/:jobId` releases the envelope only
to the requester and only while every part of it is still current, decided in
one transaction by `releaseRuntimeContextPreview`: the Work Context lock and its
locked active Setup (the planned version), then the Delivery gate itself
(`PgInvocationDeliveryAuthorizer.authorizePreviewRelease`) over **every** item,
blocked ones included — Run, Agent, Project, Folder and egress authority; the
current Message and continuity; Room recipient/routing/briefing items;
Evidence Matrix Artifact body as the ordinary Artifact detail reader releases
it (`artifactBodyReleased`: row ACL, Run Room, Source-derived gate, its
research call and, recursively, every `input_refs` Artifact, Note, Thread and
Task with their Source policy, including a Project-less input Artifact's
owning Task through `task_artifacts`), under `lockArtifactReleaseClosure`; Skill
package binding and package
(compared key-order independently, since the stored plan comes back from
jsonb); Project Brief/Instruction versions; the Run's own AgentVersion
instruction; retrieval source, Source policy and egress (a trimmed ranked item
is compared with the canonical trim) — and finally the retrieval release
closure. Each owner check takes its `FOR SHARE` locks in that transaction, so
a concurrent revocation either commits first and is seen or waits for the
release decision. The gate's outer lock order, all `FOR SHARE`, is the
canonical release-closure order: the Work Context lock → every Project its
checks lock, with its audience, in id order → this person's Space membership
→ Space → the Run's Folder → Rooms and this person's Room member rows → the
Run → Setup, Agent, Folder, Project, egress and each item's owner check.
Projects (`discoverEnvelopeProjects`, `runtimeContext/envelopeAuthority.ts`:
the Run's and control's Project, the Rooms' Projects, the Project of each
automation whose workflow the Run belongs to, the Agent's content ACL
Projects (including its mandatory retained access Project for ordinary Agent content authority; Room-only use instead rests on the locked target Room and its grants), briefing reference/version closures, Reading Method authority, each
Matrix release closure, Brief/Instruction versions, retrieval items and, for a
preview, its Work Context's Project and its retrieval release closure) come
first because Project archive takes the Project `FOR UPDATE` and then cancels
its workflow Runs `FOR UPDATE`. Rooms (the Run's conversation Room, a
`room_recipient` scope's Room, each Matrix closure's Rooms) come before the
Run because "Continue anyway" and the other Room writers take the Room before
its Runs. Both sets are discovered without locks; while the gate runs, a
Project lock outside its held set (`holdProjects`/`assertProjectHeld`,
checked by `lockProjectAudience` and `assertProjectReadableLocked` too) or a
Room outside its set (the Run's Room and the recipient Room are re-derived
under the Run lock) is a 409 (withheld), never a lock taken after the Run. The
`room_recipient` Agent read also rests on the scope's recipient row, its Room
Agent member row and the Room's Agent grants, which are not row-locked: every
writer of a member's status or a grant (`RoomRosterService` add/remove Agent
and User, invitation activation and decision) takes that Room `FOR UPDATE`
first, the scope row is insert-only and a member's Room never changes, so the
Room share excludes them; its Project check rests on the held Room Project
audience. The preview release runs its Work Context check and the retrieval
release closure after the gate, under the same held set. The Work Context
check itself (`assertActiveWorkContextReadable`) locks the effective Project
before the scope rows (session, Room, root Run, workflow execution). A PersonalMemoryGrant (execution-only, and authorizing it
consumes the grant) or any source type no owner re-checks fails closed. Any
refusal withholds the whole envelope — body, structure and provenance:
`result` is null, `withheld` is 1, and a fresh preview may be requested. The
Job applies the same gate to the envelope it produced and stores it only if it
would be released.
The switch also withholds the managed retrieval tools from a Run planned under
an off setup, and narrows them to the chosen domains under an on one
(knowledge, memory, projects → Project summaries, sources; inquiry has no
tool of its own; no choice keeps every tool) — `runRetrievalChoice` reads both
from the Run's frozen setup. It never affects material the person attaches or pins: explicit
references and `input_resource` descriptors reach the turn either way.

## Security boundaries

- A Room-only cross-Project Agent use does not authorize its retained Project.
  Acquisition withholds old Agent instructions, role/persona and Agent-bound
  Skills; automatic retrieval retains only target-Project objects. The final
  Project dependency closure refuses foreign Project context even for a viewer
  of both Projects. Global interactive search/brief tools are withheld because
  their LLM stages do not have a Project filter. Room grants are rechecked under
  the target Room lock before Delivery; generic content reads retain their ACL.
- All acquisition is Space- and instructing-user-scoped and revalidated in the
  Delivery transaction.
- Retrieval injection is audited before the items are returned: cross-person
  rows go to B11's `content_access_logs`; in execution mode the executing Run is
  passed so the person's own injected rows are attributed in the owner's
  `agent_data_read_logs` (`runtime_context.retrieval`, ADR 0030). A failed audit
  injects nothing; a preview attributes nothing to an Agent.
- Delivery revalidates the latest Setup version and its effective bindings:
  an unset Project or Project Folder inherits the persisted Run's binding,
  matching execution-control snapshot resolution. The transaction locks the
  Run and checks live Project and Folder access, including Folder status;
  explicit Setup bindings take precedence over Run defaults.
- A Room Proposal continuation may use its server-created hidden `system`
  message as the current turn only when the message is in the same Room
  conversation, carries the internal-continuation markers, names the same
  requesting user, and that user is still an active Room member. It is
  delivered as `system_approved` input and is never treated as a visible human
  message.
- Policy, credential, external-egress, tool, and budget decisions come from the
  immutable execution-control snapshot; Runtime Context does not reinterpret
  those authorities.
- Sealed replay payloads are separately encrypted and separately authorized;
  normal Run and trace reads expose only safe Invocation Snapshot projections.
- Adapters receive no provider secrets through context and no raw replay body
  through normal delivery reads.
- Delivery is passed directly at the invocation boundary and is never written
  to `CLAUDE.md`, `AGENTS.md`, Cursor rules, or another vendor context file.
  There is no compatibility alias or dual write/read path. ADR 0014 records
  the decision.

## Explicit original Skill packages

Canonical message input parts pin Skill package ids and SHA-256 versions.
Acquisition resolves reviewed `skill_bindings` using the control snapshot's
Project/Agent/user scope, including Setup overrides. Each required delegated
instruction carries original package files; the Gateway rechecks live scope
bindings and complete content before `Delivery.skill_packages` is accepted.
Run-specific source versions retain files on continuation deliveries. Only
accepted Delivery files reach the Host work surface and ACP resource links;
normalized conversion/rendering is not involved in this path. Disabling a
binding or changing stored bytes invalidates an outstanding plan. See
[Skill library](../architecture/CAPABILITY_WORKFLOW_SKILL_SYSTEM.md).

Skill delivery uses the original-package library only: `PgRuntimeSkillProvider`
delegates to `loadSelectedSkills`; acquisition and both Gateway authorization
passes preserve Run scope and revalidate bindings and exact bytes (locking on
the final pass). Hosts materialize accepted Delivery files with their original
hashes and source/planned-item references. There are no normalized Skill
renderers. The Work Skill remains a separate required code contract.
