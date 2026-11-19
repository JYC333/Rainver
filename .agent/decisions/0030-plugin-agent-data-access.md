# ADR 0030 — Plugin data classes, data-owner consent and Agent read attribution

Date: 2026-11-16
Status: accepted; platform contract implemented as stated below. Decision 4a's
isolated launch exists for ModelProvider-bound Runs on the built-in strict Host
(daemon 0.4.9+, `model_channel`); a CLI on its own vendor login and every paired
Host have no isolated path and still refuse sensitive reads. The bundled
official `applications` package uses `personal` Agent access (`permissions:
{agent: true}`, a `personal` `contact` entity and personal `contact.*`
queries/commands); like every operation-manifest plugin it is disabled until a
person enables it. Diary uses `sensitive` Agent access under these rules.
[ADR 0032](0032-gmail-on-demand-agent-read.md) applies this path to a core
Sources tool (on-demand Gmail reads);
[ADR 0033](0033-gmail-project-consent-and-private-delivery.md) gives core data
tools one standing, non-expiring `project` consent instead of decision 3's
per-Run consent, lets their Project-bound reads answer a shared audience inside
the consent's Project instead of decision 4's owner-only audience, and runs
Gmail's Project-bound tools on the conversation's own runtime instead of
decision 4a's isolated launch (plugin consents, audiences and isolation
unchanged).

## Scope

Operation-manifest plugins (P2) and the Agents that call them. Legacy
Diary/Finance business and data migration is Plan 7 (Diary done 2026-11-19). This
decision reconciles the P4 design target with the existing owners: P1
OperationExecutor, frozen Run tool snapshots, `authorization.request`,
`PersonalMemoryGrant`, Run context taint, B10 and B11. Current implementation
and API live in [OFFICIAL_OPTIONAL_MODULES](../architecture/OFFICIAL_OPTIONAL_MODULES.md#agent-data-access-adr-0030)
and [SECURITY_AND_ACCESS_BOUNDARIES](../architecture/SECURITY_AND_ACCESS_BOUNDARIES.md#8g-plugin-agent-data-access).

## Decision

1. **Classes.** `data_class` is `non_sensitive` (the normal class; unchanged
   behaviour), `personal` or `sensitive`. An entity may declare a floor that
   its operations cannot go below. A query result whose rows (`data_class` on
   the result or `items[]`) exceed the operation's class is withheld.
2. **Two axes.** What a tool does comes from the manifest (`read` = queries,
   `write` = commands; write never implies read; no wildcard). Which data it
   reaches is the data-side consent. Effective Agent authority = Run
   declaration ∩ allowance ∩ scenario ∩ data-side consent ∩ plugin enablement.
3. **Consent.** `plugin_data_grants` pins the toolset expansion
   `{action_id, action_version, data_class, side_effects, gate_class}` at write
   time. Personal consent is a Space owner's, Space-wide. Sensitive consent is
   only the data owner's — for caller-owned plugin data, the person the Run acts
   for — bound to one Run (default 1 h) or, read-only, to the owner's own
   scheduled Runs (`background`, default 24 h); always expiring and revocable.
   The database refuses a sensitive row whose grantor is not its owner.
   Requesters, administrators and Space owners cannot write it for them.
4. **Scenarios** (one pure predicate for snapshot and call time): sensitive
   tools and every personal/sensitive write need an owner-only audience (Room
   readers by the Rooms owner's `roomAudience` — a mainline is every Project
   reader — selected-user grantees, every member of a Space-shared Run); writes
   are proposals from a person's own turn only; delegated Runs and unattended
   system wakes never get sensitive tools; scheduled Runs only with the owner's
   background consent. A shared audience may get personal *reads* only, and
   only as the readable intersection: the same read-only query runs as each
   other current reader (active member, plugin enabled) and only rows every
   result contains are released. Every non-row field (a total, cursor or
   summary, at any depth) is released only when it is identical in every
   reader's result; otherwise nothing is released — fields are never stripped
   to fit. A result that is not a list is released only when all results are
   identical. The release rechecks the audience. Refused
   tool names are absent from the snapshot. The one exception to the
   owner-only audience is a Project-bound core read
   ([ADR 0033](0033-gmail-project-consent-and-private-delivery.md) §6): in the
   consent owner's own turn (or their scheduled digest Run) it may answer a
   shared conversation of the consent's Project while every reader still reads
   that Project; plugin tools keep the rule above.
4a. **Isolation for sensitive data.** A person's consent cannot stand in for
   network isolation. Sensitive data is released only to a Run whose live latest
   attempt carries the server-written launch record (with its launch nonce) of
   the built-in strict Host and egress `none`. The dispatcher composes that
   launch itself when the Run's frozen snapshot pins a sensitive tool, the Run
   is bound to a ModelProvider and the built-in daemon reports `model_channel`:
   egress narrows to `none` and the namespace keeps one **model channel** — a
   loopback forwarder inside it, piped to a Unix socket bound read-only, relayed
   by the daemon only to `/<route>/<lease_id>` of this Run's provider-proxy
   lease (no CONNECT, upgrade, absolute-form target, other path or destination).
   The lease is server-issued, revocable and revoked at Run end; the upstream
   key stays in the server (ADR 0008). It is a `model_only` lease, held at the
   provider proxy on every request whatever path it arrives by
   (`providers/proxy/modelOnlyPolicy.ts`): `POST` to the inference endpoint of
   the bound CLIs only (Anthropic Messages and count_tokens, OpenAI Responses,
   Chat Completions), JSON naming the lease's own model (required), and an
   allowlisted request structure — client tools only, no hosted/server tool
   (web search/fetch, code execution, computer use, MCP, file/tool search,
   image generation), no URL- or file-id-sourced content — in a message or a
   tool's output, which carries the same content blocks — no file, batch,
   model-listing or stored-response endpoint, nothing stored (Responses must
   send `store: false`, its default being to store), no unknown field. A model-only
   binding needs a named model and switches Codex's hosted web search off in
   its own config (`web_search = "disabled"`); the relay forwards `POST` only.
   The provider would otherwise egress on the Run's behalf where the
   namespace cannot see it. The record adds
   `model_channel: "provider_lease"` and the CLI `profile_key`. A Run on the
   CLI's own vendor login, a paired Host, or an older daemon gets ordinary
   egress and no release. An isolated Run of a conversation launches only in
   that Session's own profile and cwd with nothing shared writable
   (ADR 0032 Consequences); a Session-less Run that must launch isolated (a
   sensitive conversation's continuation) is refused
   (`sensitive_profile_session_unconfirmed`), while a Session-less background
   plugin read keeps its Agent profile (ADR 0032, Not covered). Gmail's Project-bound
   core tools never take this launch: they read through the server's broker
   on the conversation's own runtime
   ([ADR 0033](0033-gmail-project-consent-and-private-delivery.md) §6). Model
   reception is part of the consented Run; every other outward path stays
   refused (decision 7).
5. **Frozen snapshot, live recheck.** The Run snapshot pins each plugin tool's
   contract. Every call — and every idempotent replay — rechecks pin, live
   audience, origin, enablement and the consent row. An upgrade never widens a
   running snapshot; changed tools need re-consent; removed tools shrink.
   Normal-read auto-extension on upgrade is not enabled (default deny).
6. **Request flow.** A missing consent is a requestable policy denial
   (`plugin_data_consent_required`, error `operation_consent_required`); the
   Agent uses `authorization.request`, and the existing Run controls let only
   the data owner (sensitive) or a Space owner (personal) decide it.
7. **Release, taint, egress, Memory.** Classification reads the raw plugin
   output before DTO validation (a label may raise, never lower, and any label
   above the pinned class withholds). Every released body — query, command
   after commit, idempotent command replay (with host-only release facts kept
   on the receipt) — passes one release gate in a separate audit transaction
   under one lock order: people → Run (`FOR UPDATE`) → plugin installs →
   enablements → consent (`FOR SHARE`); disable and revocation take the install
   and consent rows `FOR UPDATE`. It rechecks actor, audience, dependency
   enablement and consent, merges `plugin_reads` into the Run's merge-only taint
   and writes the content-free attribution row. After a sensitive read every
   outward Agent write is refused by a hard invariant; Memory writes become
   gated proposals carrying at least `sensitive`; persona changes are refused.
   There is no owner-approved egress review path; outward writes stay refused.
8. **Attribution (B11 unchanged).** `content_access_logs` keeps recording only
   cross-person reads. A separate contentAccess-owned `agent_data_read_logs`
   records Agent reads on the owner's behalf — plugin reads, typed references,
   executor-routed core content queries, retrieval search and brief (the
   managed dispatcher passes the executing Run and the admitted action, e.g.
   `memory.retrieval.brief`) and runtime-context injection, same-owner
   included — with bounded ids and the class, never
   content, and fails the release when it cannot be written. The owner alone
   lists it, sees the consents a Run used (including background consent) and
   revokes them.
9. **Core ports.** Plugins reach Tasks, Relations (person), Memory (proposal),
   Artifacts (private inline creation through the canonical Artifact writer,
   commands only) and readable references (queries only; every current reader
   and the Agent's Project scope; rechecked and audited at release) only through
   declared typed ports that run the canonical owners in the operation
   transaction; there is no general core SQL port. An Agent never carries
   personal/sensitive plugin data into a write port. Notes are read through
   `notes.read`; the only Notes write is `notes.draft` (2026-11-18), for a person
   alone: a private generation Run over pinned readable revisions that the Source
   egress rules also let go to the provider used (policy passed to the invocation and
   rechecked before each send under the worker's current Job claim, with the
   Project audience, input Notes and Sources held through send admission and result
   commit, and every failure settled under that claim too; reading a Note
   is not consent to send it), readable on generic Run entries only by that person
   while every input and its Sources stay readable, and saved once through
   Knowledge's own Note operations with `expect_version`, only into a Note no one
   else reads (Space oversight included, decided under the save's locks; a member
   joining meanwhile waits on the Space audience fence) or a new
   Project-free private Note where the ordinary creation rule keeps it in that
   Space; the saved Note inherits the inputs' Source lineage, pinned to the Sources it
   was derived under, and its body and history answer to that lineage on every read.
10. **Context push.** `include_in_context`/`can_contribute_context` have no
    consumer; operation descriptors declare `never`. Plugin data reaches an
    Agent by consented, audited pull only. A push port would need its own
    decision.

## Consequences

Existing non_sensitive paths, user access and the refusal of unconsented
sensitive Agent access are unchanged. Implemented: the classes, consent,
scenario and shared-audience intersection, the release gate, attribution
across plugin, executor, retrieval and runtime-context reads, the four write
ports and query-only references, the launch-isolation proof, and the
dispatcher-selected egress-`none` launch with a model-only channel for
provider-bound Runs on the built-in strict Host (real-bubblewrap acceptance with
a synthetic model service and a synthetic CLI). Not implemented and not
claimed: an isolated path for a CLI on its own vendor login or on a paired Host,
acceptance with a real vendor CLI or live provider under egress `none` (a CLI
endpoint other than its bound model — telemetry, updates, web tools — simply
fails there), normal-read auto-extension on upgrade, an owner-approved egress
review path, and any context push port.
