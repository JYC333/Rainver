# ADR 0033 — Gmail: one owner consent per Project, private execution and delivery

Date: 2026-11-18
Status: accepted. §6 runs reads in place on the conversation's own runtime
(no private check) and offers digests in every ordinary conversation; §7 is the
cutover of consents given under the earlier private scope. The workspace branch implements standing
consent, in-place reads and searches in every ordinary conversation of a
Project, digest setup and delivery in the owner's private conversation, a Room
or the mainline on that conversation's runtime, the later-turn Project
constraint, the cutover of earlier consents and explicit owner sharing to a Room
or its Project mainline. Live Google acceptance remains outstanding.
[ADR 0034](0034-gmail-application-updates.md) adds a third digest kind, `application`
(automatic Application updates), on the same card, consent shape and scheduler, with an
owner-only conversation and a pinned Agent and model.
[ADR 0035](0035-gmail-shared-project-scope.md) adds one combined card for several purposes, pins digests to
the configuration their card shows (a change pauses them until a new card), and a standing read-only
delegation to named Project members that is a separate authority; §2's rule that members never use the
owner's consent stands.

## Context

[ADR 0032](0032-gmail-on-demand-agent-read.md) let an Agent read the owner's
mail through [ADR 0030](0030-plugin-agent-data-access.md)'s sensitive path,
but only in a non-Room direct chat and only with a consent for each Run (one
hour, ten reads). The owner asked for one confirmation in a conversation that
then holds across their conversations of the same Project until revoked, one
place to manage it, Room-initiated requests that still execute and deliver
privately, and — later — unattended daily and rule-matched summaries.

## Decision

1. **One consent, bound and standing.** A core data tool's only consent is a
   `plugin_data_grants` row of scope `project`: read-only, sensitive, grantor =
   data owner, bound to one Project, one connection of the owner **at its
   current generation**, and one purpose (`on_demand_read`). It has no time
   limit. The database refuses any other active consent for a `core:` id and a
   `project` consent for anything else (`ck_plugin_data_grants_core_scope`,
   `ck_plugin_data_grants_shape`, `ck_plugin_data_grants_binding`). This
   replaces ADR 0032's per-Run consent and ADR 0030 §3's "always expiring" for
   core tools only; plugin consents are unchanged. Migration
   `0033_gmail_project_agent_read_consent` ends still-active per-Run Gmail
   consents (status `expired`, kept as history). There is no fallback to them.
2. **Who and where** (with §6). Only the mailbox owner can give it
   (the authorization request's data-owner approver, as before) from a Run of
   their own turn in an ordinary conversation of a Project, while they read
   that Project. It admits a Run only when the Run's conversation is an
   ordinary conversation of the same Project, the Run is the owner's
   `manual` turn, every reader of the Run reads that Project, the connection
   is active, opted in and still at the bound generation, and the owner is
   still an active Space member who reads that Project. The
   request freezes owner, Project, connection, generation and purpose; its
   card shows the owner that mailbox and Project, and approval writes exactly
   that binding after rechecking each part live, or nothing. A request
   without a frozen binding (made under ADR 0032's per-Run consent) is never
   approved; it can only be rejected.
   Project members, administrators, Space owners, delegated, scheduled and
   system Runs never use it. A conversation outside every Project is not
   offered the tool. A Project private chat that may read is created
   owner-only (`visibility = private`) instead of Space-shared.
3. **Paginated reads.** Agent reads use Gmail page sizes and continuation tokens.
   The consent, the owner's current Project access,
   the connection generation and the running Run are rechecked at admission,
   before every Gmail send and at release. The release takes the Project
   lock first, as the Project membership writer does.
4. **Ending.** Revocation (Gmail card, Run panel), turning Agent reads off,
   disconnect, reconnect and re-authorization end every consent of that
   connection (`status = revoked`); turning reads on again restores none.
   Leaving the Project (member removal) ends the owner's consents for it in
   the membership writer's transaction, and disabling the account ends all of
   theirs; being added back or re-enabled restores none. A
   changed generation stops admission even before the writer runs. Ending is
   immediate and needs no confirmation; any widening — another Project,
   another mailbox, a new purpose — needs a new confirmation card.
   The same writers (and forgetting the connection) end a still-pending
   request for such a consent: status `expired`, decided by nobody, its Run
   cancelled; regaining access never revives it. Until then the card's
   approvability is the server's projection (`consent_state`), naming the
   mailbox only while every part an approval rechecks holds. An approval
   writes only while its Run still waits for exactly that request (checked
   under the Run lock), and takes the connection before the request row —
   the order every connection writer keeps — so an approval and a concurrent
   opt-out, disconnect, reconnect, re-authorization or forget serialize: the
   writer either ends the request first, or waits and then ends the consent
   the approval wrote.
   A private Run that may read mail (its snapshot pins a Gmail tool) is
   owner-only; a Room or mainline Run keeps its conversation's audience (§6).
   In every conversation a core data tool's requests — reason, resource,
   Project — are listed and decided by the mailbox owner alone, never a Space
   owner.
   Forgetting a disconnected connection deletes it and its monitor data; its
   ended consents and approved requests stay as evidence, naming the
   connection only as a snapshot (migration
   `0035_gmail_consent_history_and_request_end`), and never admit again.
5. **One management place.** Sources → Access and Gmail lists, per connection,
   the switch and each allowed Project with its last use and a revoke action.
6. **Ordinary conversations.** Reads run in place, instead of the former
   hand-off into a new private conversation or the in-place private check
   (see *Withdrawn paths*).
   The owner asked that an ordinary Project conversation keep its selected
   CLI, Host, native login and model and read Gmail through the backend, with
   one confirmation that then holds across that Project, no new conversation
   or navigation, output for the conversation's audience, and nothing
   inherited by another Project. So:
   - **Where and who.** `source.gmail.mail.read` (the newest inbox messages or
     a Gmail search, with paginated plain-text results) is offered
     in every ordinary conversation of a Project — the person's own private
     conversation, a Room or the Project mainline — in the mailbox owner's own
     `manual` turn, when their connection allows Agent reads. Chats outside a
     Project, other people's private conversations and delegated, scheduled
     or system turns are not offered it.
   - **The runtime is the conversation's.** The read goes through the server's
     Gmail broker (§3's allowlist, budgets and per-send rechecks); the
     credential never leaves the server and the runtime receives only the
     bounded result. Gmail's tools are **Project-bound** core tools
     (`coreDataTools.ts`): unlike a plugin's sensitive tool they need no
     isolation proof, so the Run keeps the conversation's own runtime — a
     paired Host, a CLI on its own vendor login (`runtime_native`) or a
     ModelProvider binding — and is never selected for the model-only channel.
     This amends ADR 0030 §4/§4a and ADR 0032's isolated launch for these
     tools only; a plugin's sensitive tool and a conversation holding
     sensitive plugin data still launch isolated or not at all.
   - **One confirmation, in place.** A missing consent is
     `operation_consent_required`; the Agent calls `authorization.request`,
     the turn waits, and the mailbox owner approves on the card in that same
     conversation. The request freezes owner, the conversation's Project,
     mailbox, generation and purpose as in §2; approval writes exactly that
     §1 consent and requeues the **same** Run, which continues the original
     request. A core tool's request exists only for the mailbox owner, in any
     conversation: other Room members and Space owners neither see nor decide
     it. The consent then serves the owner's turns in every conversation of
     that Project until §4 ends it.
   - **The Project is the boundary.** A consent admits only a Run whose
     conversation and Project are its own; another Project's conversation
     asks again and never sees the earlier reads. The result is released to
     the conversation's audience only while every reader of the Run reads the
     consent's Project (`audienceWithinProject`, at call time and in the
     release gate under §3's lock order); otherwise the call refuses with a
     fixed code and sends nothing. Without a consent the same rule applies to
     the conversation's Project: no card is offered or written for such a
     Run, a pending card stops being approvable, and an approval rechecks it
     and writes nothing. The reply belongs to the conversation: a
     Room or mainline reply is a Room message for its audience; a Run of the
     owner's private conversation stays owner-only.
   - **Untrusted input, bounded context.** Mail is data, never instructions.
     The reading Run's taint refuses its outward writes and materializes no
     artifact, proposal or activity from it; session reflection makes no
     Memory of such a conversation. The read does not mark the conversation
     for isolation: later turns keep its runtime.
   - **Later turns keep the Project constraint.** What a read put into the
     conversation's history stays there, whatever Host or isolation the next
     turn has: every later Run of that conversation (any member's turn, a
     continuation or a digest) inherits the read's taint at creation, decided
     separately from `sensitive_conversation` (which only a plugin's
     sensitive data sets). So a later turn's outward writes are refused,
     nothing is materialized from it, and `memory.remember`/`memory.revise`
     refuse outright (Memory is recalled in other Projects; not even a gated
     proposal is made). Conversation history tools read only their own
     conversation, Room references and owner sharing are same-Project only and
     carry the read with them: a reference from such a conversation is fenced
     as untrusted and records `source_project_id` and `sensitive_reads`, the
     owner's shared excerpt records the same on its message, and every later
     Run of the conversation they land in inherits the read. Only the mailbox
     owner may widen a reference to their mail beyond its source audience
     (under the ordinary disclosure confirmation); anyone else's is refused
     (`reference_sensitive_scope_mismatch`). Reads keep their real mailbox
     owner through every inheritance and hop, never the person instructing a
     later turn; an old entry that cannot be proven to be its instructing
     person's stays unknown, an old record (without `sensitive_reads_version`)
     is checked against its source or else counts as unverifiable, and
     malformed read metadata never counts as none (a malformed Run taint,
     even at the top level, keeps the current Run's outward-write, Memory,
     materialization and merge protection, as it makes its conversation's
     answer incomplete; an explicit JSON null field is malformed, not
     absent); when a conversation's
     reads cannot all be determined it is not copied
     (`reference_sensitive_reads_unresolved`), reflection makes no Memory,
     the owner's excerpt is not shared (`gmail_summary_share_foreign_data`)
     and its later Runs inherit an unknown-owner read. Another Project's conversation has
     its own container. Each Project conversation
     has its own host container, so no vendor session or CLI state carries
     reads to another Project.
   - **Withdrawn paths.** `source.gmail.private_read.request` and
     `source.gmail.private_check.request`/`.get` are removed. Their owner-only
     cards are history, never decided, continued or linked; accepting one is
     refused with nothing written. Migration
     `0039_gmail_private_check_withdrawn` closes pending check cards and ends
     unfinished checks; a Run a check started is refused before dispatch and
     at launch. The Session-less `run` container (formerly §6a) is no longer
     selected by the server; the Host daemon's support for it is unused.
   - **Web.** Owner-only Gmail cards never offer the generic "continue to next
     step", which started an unrelated Agent follow-up.

7. **Upgrade cutover.** A consent given under the earlier private,
   isolated scope is not silently widened to §6 and the digests of B.
   Migration `0040_gmail_project_scope_reconfirm` ends every active Gmail
   consent (`revoked`, decided by nobody) and every pending in-conversation
   consent card (`expired`, its waiting Run cancelled by the reconcile job),
   closes pending digest cards (`superseded`), stops unfinished deliveries,
   and pauses each live digest with `gmail_digest_reconfirm_required`,
   keeping its mailbox, Project, conversation, Agent, time, time zone and
   delivery history. Nothing runs, resumes or is retimed until the owner
   confirms again: an on-demand read asks in place as any first read does; a
   digest is confirmed on a new card in its own conversation, which
   reactivates the same digest (coverage from the confirmation). A card from
   another conversation never ends or replaces it: drafting there is refused
   (`gmail_digest_reconfirm_elsewhere`) and a card from there conflicts (409),
   until the owner confirms the digest in its conversation or ends it. Ordinary
   conversations, messages and Runs are untouched.

## Digest and sharing behavior

- **B — daily and rule digests.** A digest is set up in the
  mailbox owner's own `manual` turn of an ordinary conversation of a Project —
  their private conversation, a Room or the mainline — and delivers only into
  that conversation; a Room or mainline only while the owner is one of its
  readers and every reader reads the Project (refused otherwise with
  `gmail_digest_audience_outside_project`). The owner explicitly enables it on
  one owner-only confirmation card per digest (other members and Space owners
  neither see nor decide it), which shows the mailbox, trigger, window and the
  delivery conversation (and that every member of a Room reads it). Daily digests
  show their time and time zone. Monitor digests trigger when matching mail
  is recorded. Each purpose
  (`daily_digest`, `rule_digest`) uses the same `project` consent shape. The Sources
  scheduler admits an automation-origin Run bound to the delivery
  conversation, deadline-bounded, on that conversation's own runtime (no
  isolated launch; the read goes through the server's broker):
  in a private conversation an owner-only turn; in a Room or the mainline one
  scheduled Room turn of that same conversation (its Agent, backend, Host
  thread and audience; no new conversation), whose reply is the Room's message.
  Admission, the Run's claim, every Gmail send, the release and the settlement
  recheck the consent, its generation, the owner's Project access and that the
  conversation's audience is inside the Project, by one rule
  (`gmailDigestConversationAdmits`): the owner must read the Room or mainline
  through its own gate (never added by the rule), and its readers are
  its Project readers plus every active roster row (a person removed from the
  Project keeps their Room row, and a Room Run's grantees come from it) plus the
  delivery Run's own audience. A refusal settles the delivery as failed with
  `gmail_digest_audience_outside_project`, keeps the frozen window and stores no
  reply; revocation, pause and every §4 ending stop it as before. The
  monitoring worker also checks for pending digests after committing matches. The daily
  window starts at the last covered boundary and ends at the scheduled slot
  during regular operation. Its catch-up bound is 24 hours or a longer
  scheduled daily interval during a clock rollback. It is limited to INBOX
  with server-set time bounds. Explicit resume restarts coverage at resume time.
  The owner can edit the daily time in the existing time zone under the same consent. Rule digests read and
  deduplicate the server-matched message IDs. Pause and revoke on the same Gmail card. Both purposes use the
  owner's `project` consent under `core:gmail_digest`; ADR 0032 §1's rule that core tools have no
  `background` consent stands.
- **C — sharing.** An Agent never sends mail content anywhere. The owner may
  pick text from their private result, preview and edit it, choose the
  audience, and send it under their own identity to a Room or the Project mainline
  conversation. The user-only command rechecks source ownership and destination
  membership and checks the audience against the effective readers shown in the
  preview. A changed audience needs a new review before posting. The command
  records provenance via its action receipt and policy audit, and posts only the
  preview text. It starts no Agent Run.

## Consequences

- ADR 0030 §3/§4/§4a and ADR 0032's per-Run consent, non-Project offering and
  isolated launch are replaced as stated (ADR 0032 now states the result), for
  Gmail's Project-bound tools only; every other rule of both (release gate, taint,
  attribution, host-state rules for sensitive plugin data) is unchanged.
- Implemented in `server/src/modules/sources/gmail/gmailAgentReadGrants.ts`,
  `gmailAgentReadAvailability.ts`, `gmailAgentReadOperation.ts`,
  `gmailDigests.ts`, `gmailDigestReadOperation.ts`, `gmailConnections.ts`,
  `gmailTokenRefresh.ts`, `plugins/coreDataTools.ts` (`projectBound`),
  `plugins/dataAccess.ts` (`pluginDataEligibility`, `audienceWithinProject`,
  `findConsent`), `plugins/dataGrantRepository.ts`,
  `policy/authorizationRequestService.ts` (core requests owner-only),
  `runs/sensitiveRuntimeProfile.ts`, `runs/modelChannelLaunch.ts`,
  `runs/contextTaint.ts`, `runs/repository.ts`, `ontology/entities.ts`,
  `agents/chatOperations.ts`, `projects/repository.ts` (`removeMember`),
  `auth/accountOperations.ts`; the withdrawn cards in
  `gmailPrivateReadHandoff.ts`, `gmailPrivateReadBinding.ts` and
  `gmailPrivateCheck.ts`; UI in `GmailConnectionsCard.tsx`,
  `ActionPreviewCard.tsx`, `ConversationRunControls.tsx`,
  `policy/consentRequestLifecycle.ts`. Migrations
  `0034_gmail_consent_binding_and_shape`,
  `0035_gmail_consent_history_and_request_end`, `0038_gmail_private_checks`
  (closes hand-off cards), `0039_gmail_private_check_withdrawn` and
  `0040_gmail_project_scope_reconfirm` (§7); Room digest turns in
  `rooms/service.ts` (`queueUnattendedTurnInTransaction`) and
  `agentGroups/service.ts` (`unattended`); the later-turn taint in
  `runs/repository.ts` and `memory/memoryDirectWriteExecutors.ts`; copies
  that keep it in `rooms/threadReferences.ts`, `rooms/referenceService.ts`,
  `gmailSummaryShare.ts` and `runs/contextTaint.ts`
  (`sensitiveConversationReads`). Tests:
  `server/test/gmailAgentReadDb.test.ts` (including the paired-Host
  `codex_cli` native-login acceptance and the later-turn taint),
  `server/test/gmailRoomReadAcceptanceDb.test.ts` (in-place Room read; no
  card for an audience outside the Project and its recheck at approval; a
  Room reference of a Gmail reply and its later turn's refusals; a
  mainline digest from draft to scheduled Room reply and the later turn's
  refusals), `server/test/gmailMonitorSyncDb.test.ts` (digest on the same
  runtime; the 0040 upgrade and re-confirmation),
  `server/test/gmailPrivateReadHandoffDb.test.ts`,
  `server/test/sensitiveRuntimeProfileDb.test.ts`,
  `GmailConnectionsCard.test.tsx`, `gmailPrivateReadCard.test.tsx`.
- Not covered: whether an Agent recognizes a Gmail need is the model's
  judgment. The conversation's CLI and its model provider process what is
  read; the card says so, and that is separate from Rainver's Project
  boundary. A consent is not ended automatically when the owner stops
  working in its Project. A Room's or mainline's digest is read by every
  member of that conversation (all inside the Project), as its card says. Real
  acceptance with a Google project and a live CLI is still not performed.
