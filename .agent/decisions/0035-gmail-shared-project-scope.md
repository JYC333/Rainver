# ADR 0035 — Gmail: one authorization across a shared Project

Date: 2026-11-22
Status: accepted. Implemented in the workspace branch with synthetic mail on real PostgreSQL;
no real mailbox, Google project or live rule has been used, and Google access stays read-only.
[ADR 0036](0036-gmail-application-execution-choice.md) amends §1: the Agent and model are chosen on the card, and the
private execution conversation serves every application-update card, also one from the owner's private conversation.

## Context

After [ADR 0033](0033-gmail-project-consent-and-private-delivery.md) and
[ADR 0034](0034-gmail-application-updates.md) the owner confirmed on-demand reading once per Project, but
automatic application updates could be enabled only from their private conversation, each digest and the
automation needed its own card, a scheduled digest ran on whatever runtime its conversation was bound to at
the time, and no other member could read the owner's mail at all. The owner asked that a team work in its
shared Project conversation with one decision: operating the mailbox stays the owner's, the results the
owner allows are shared with the Project, the owner may hand standing read access to named members, and once
something is allowed it keeps working without being blocked again. The joint review also found that the
consent card promised limits the server no longer enforced (5 messages, 10 reads per turn) and that no card
said later members read the conversation's history.

## Decision

1. **Application updates from a Room or the mainline.** The owner's own `manual` turn in any ordinary
   conversation of the Project whose every reader reads the Project may draft the automation
   (`source.gmail.application_updates.propose`). The owner-only card names the mailbox, the Agent and pinned
   model (ADR 0034 §3, unchanged), the facts it may record, and its audience: the conversation's current
   readers and that everyone who later reads its history (a later Room member; every later Project member for
   the mainline) reads what is posted there (`payload.audience`, `GmailCardAudienceSchema`). Acceptance
   refuses (409 `gmail_digest_audience_changed`) a card whose conversation gained a reader since drafting.
   - **Mail stays in a controlled place.** The automation itself runs, exactly as ADR 0034 states, in an
     owner-only conversation: acceptance creates (or reuses) the owner's private *execution conversation* of
     the Project (`sessions.metadata_json.gmail_application_execution`) and resolves its Agent binding as the
     owner's own (`resolveBinding` with the card's runtime profile requested, then the card's session
     options), so a Host or login only the Room could reach never receives the mail
     (409 `gmail_digest_runtime_unavailable`); the result must equal the frozen binding
     (`applicationUpdateRuntimeMatches`). Every ADR 0034 gate (owner-only audience, proven model, release,
     fact gate, flags, settlement) applies to that conversation unchanged; mail text, the model's report and
     per-message outcomes stay there.
   - **Only structured, shareable results reach the Project.** A fact `mail_fact.apply` records on an
     application the Project reads (`project_shared`) is kept as a structured row
     (`gmail_application_shared_results`: application label, effect, before/after; never subject, sender or
     text) in the same transaction; a fact on an application only the owner reads is neither kept nor
     mentioned. After a successful delivery, system notices of up to 50 results each are posted
     into the enabling conversation (`gmail_digests.notice_session_id`), only while every reader of it reads the
     Project (`gmailDigestConversationAdmits`, also checked at start, rechecked live when posting). Each row is
     rechecked when the notice is composed, not when its fact was recorded: an application made private or
     removed since is deleted unposted and never mentioned, and the label shown is the application's current
     one (read and locked through the Applications package role). Each batch requires effective Applications
     enablement for the active owner and a live Project binding, locked through publication. Unbind or
     disablement defers pending notices. A fact committed by a delivery that then failed waits and
     becomes eligible after the next successful delivery. The scheduler can continue posting that delivery’s
     eligible rows without a new Run or Gmail request, while the settled Run of the current card still exists.
     Pending new mail does not block this check. The ledger deduplicates on the committed Applications
     fact ID per automation and marks rows posted in the same transaction as the notice. A deadline notice names
     its kind. Legacy rows retain their posting state and use a generic deadline label when the kind is absent. Each row is bound to
     the conversation and card it was recorded under (`notice_session_id`, `rule_version`): only a notice into that
     conversation under that card posts it, and once the automation is re-carded (another Room, the mainline,
     other facts) a waiting row is deleted unposted, never carried to the new audience. Members read the
     records themselves through Applications' own permissions.
   - **Managed where the team works.** `.list` and `.set_status` are admitted in the same conversations;
     in one someone else reads, `.list` is content-free (no mailbox address, per-message outcomes or links,
     and no derived read in the Run's taint). Resuming or widening is still a new card.
2. **One card for several purposes.** `source.gmail.setup.propose` drafts one owner-only `gmail_setup` card
   for what the owner asked for here — on-demand reading, a daily digest, a rule digest, application
   updates. Each part is drafted by its own drafting code in draft-only mode (same refusals as its own
   card), and acceptance writes each part exactly as its own card would (`applyGmailDigestCard`, the
   `core:gmail` `on_demand_read` consent after ADR 0033 §2's rechecks), all in one transaction. Each keeps its
   own consent row and automation, so each pauses, ends and is revoked on its own; a digest row is unique
   per card and kind (`uq_gmail_digests_proposal_kind`). What is already allowed — a live on-demand consent,
   an active digest of that kind delivering into this conversation by this Agent, at the asked time and time
   zone (daily) and still on the configuration its card showed (`digestRuntimeMatches`), an active automation
   with the same facts, binding and delivery — is reused and listed, never asked again; when everything is, no
   card is drafted. An active digest of that kind that differs in any of these is not reused: the card's part
   names what it is now and changes it in place on acceptance (`replaces_digest_id`: new time, time zone,
   conversation and binding, a new consent replacing its old one, coverage and history kept, a running
   delivery ended). The part freezes the version it was drafted against (`replaces_proposal_id`, the accepted
   card in force, and `replaces_local_time`); acceptance locks the digest and refuses it (409
   `gmail_digest_changed`) once that digest ended or another card or the owner's own time change altered it, so
   of two such cards accepted out of order the stale one never overwrites the newer setting.
   A new purpose, more facts, another Agent or model, another mailbox or Project is a new card.
3. **Digests run on the configuration their card shows.** A daily or rule digest card freezes the
   conversation's binding for its Agent (`runtime_binding`: runtime profile, runtime, backend, provider,
   model, session options and the resolved explicit model when there is one) and shows "Runs on <Agent> with
   <model>". No model proof is required (a summary is the conversation's own reply, ADR 0033), but nothing
   switches silently: acceptance refuses a changed binding (409 `gmail_digest_runtime_changed`); at start a
   changed binding — or a digest confirmed before cards named one — pauses the digest
   (`gmail_digest_runtime_changed`, no Run, no Gmail request); the generic resume refuses it; a new card in its
   own conversation reactivates the same digest in place, with its history and one consent
   (`GMAIL_DIGEST_RECONFIRM_CODES`). Every digest turn — private, Room or mainline — applies the confirmed
   session options strictly (`pinnedSessionConfig`; the Room path through `prepareRoomConversationBackends`), so
   a live session that does not apply them fails the turn instead of keeping the runtime's default. What the
   Run actually runs on is checked too (`digestRunOnConfirmedRuntime`): as created at start (its conversation
   backend and profile — a profile switched in place to another runtime, backend or Provider pauses the digest
   before anything is queued), and before every Gmail send, at release and at settlement (runtime, profile
   snapshot, Provider and the launch-bound model, applied options neither dropped nor switched, e.g. by a quota
   model switch). A mismatch reads no mail (409 `gmail_digest_runtime_changed`), stores no reply and pauses the
   digest with that code, never switching to a model nobody confirmed. A provider-bound summary Run's lease is
   built only for the model its card showed and pinned to it for the lease's whole life (as an automation's,
   ADR 0034), so no later inference of the Run over mail it already read can use another model.
4. **Standing read-only delegation to a member.** The owner's card (`source.gmail.delegation.propose`,
   `gmail_read_delegation`) lets one member of one Project read and search one mailbox from that member's own
   turns in that Project's conversations, confined to a Gmail search scope the owner states
   (`gmail_read_delegations`: connection at its generation, Project, member, `query_scope`). It is not an ADR
   0033 consent and never admits the owner's own tool; ADR 0033 §2's "Project members never use it" stands for
   the consent.
   - **Read (`source.gmail.delegated.read`).** Offered in the snapshot only where such a delegation exists for
     the conversation's Project. Admitted only in the member's own `manual` turn, in an ordinary conversation
     of that Project whose readers all read it, while the delegation is active, the connection active, opted
     in and at the bound generation, and both people active readers of the Project — at call time, before
     every Gmail send and at release (Project → people → Run → owner + Space mutex → connection → delegation,
     the order every ending takes). Each of these checks is the whole admission, and the conversation's readers
     include a Room's active roster (a roster row outlives Project membership, as for digests), so someone
     outside the Project who joins the Room between two Gmail sends of one read stops it before the next send
     and nothing is released. Every query is `(<scope>) (<words>)`; the member's words may not contain
     parentheses or braces and their quotes must balance, and a scope must be balanced, so the scope group
     can never be closed or bypassed; the read contract stays the read-only `messages.list`/`messages.get`.
   - **The owner's data and audit.** The Run's taint records a sensitive `core:gmail` read whose owner is the
     mailbox owner (a non-instructing owner: outward writes, Memory and materialization are refused, later
     turns inherit it) with `gmail_scope.grant_id` the delegation id, which no consent-based exemption
     admits. The owner's audit gets a `delegated_read` row (actor = the member, the delegation; counts only),
     and the delegation its read count and last use, shown under Sources → Access and Gmail.
   - **Ending.** The owner ends it at once (`source.gmail.delegation.end` in conversation,
     `source.gmail.delegation.revoke` and the Access page); it ends with every ending of the connection's
     consents (`endGmailAgentReadGrants`; forgetting deletes it) and when either person leaves the Project or
     is disabled (`endProjectDataConsents`). A read in flight then sends nothing more, and a page already
     fetched is withheld at release. Nothing revives it; a new card is needed.
5. **Copy says what the server does.** The consent card and the Access page state the actual limits (5
   messages per page by default, up to 500, further pages on request, no per-turn count) and that answers,
   digests and application updates are visible to people who later join and can read the conversation's
   history. Sending, drafting, labelling, archiving and deleting remain out of scope; they need new Google
   scopes and conflict with ADR 0030 §7, and would need their own ADR.

## Consequences

- Amends ADR 0034 §2 and §8 (shared enabling conversation, private execution, structured notices,
  content-free management where others read) and ADR 0033 (digests' pinned configuration; combined card;
  delegation as a separate authority). Every other rule of ADR 0030, 0032, 0033 and 0034 stands.
- Upgrade: digests confirmed before this change pause at their next start with `gmail_digest_runtime_changed`
  until the owner confirms a new card in their conversation; a pending Room or mainline digest card drafted
  before cards carried an audience is no longer accepted (409) and is drafted again.
- Code: `server/src/modules/sources/gmail/gmailApplicationSharedConversation.ts`, `gmailSetupProposal.ts`,
  `gmailDelegations.ts`, `gmailDelegatedReadOperation.ts`, `gmailApplicationUpdates.ts`, `gmailDigests.ts`,
  `gmailDigestProposal.ts`, `gmailApplicationUpdateRuns.ts` (`digestRuntimeMatches`), `gmailAgentReadGrants.ts`,
  `gmailConnections.ts`, `gmailOperations.ts`; `plugins/operationRegistry.ts`, `plugins/egress.ts`,
  `plugins/dataGrantRepository.ts`, `systemActions/runToolGrants.ts`, `systemActions/scenarioToolAllowance.ts`,
  `runtimeAdapters/privateToolCalls.ts`, `ontology/entities.ts`, `proposals/payloadSchemas.ts`,
  `agents/projectChatActionPreviews.ts`, `agentGroups/service.ts` (strict options for scheduled Room turns),
  `runs/remoteProviderBinding.ts` (a summary's lease pinned to its card's model); package `plugins/official/applications` (`mail_fact.apply` returns `project_shared` and the application's
  label, fact ID and deadline kind); migrations `0026_gmail_shared_project_scope`, `0027_gmail_shared_result_posting`,
  `0028_gmail_shared_result_binding`, `0029_gmail_shared_result_fact_identity`; protocol
  `gmail.ts`, `systemActions.ts`, `policy.ts`, `proposals.ts`; web `GmailConnectionsCard.tsx`, `api/gmail.ts`, i18n.
- Tests (real PostgreSQL, synthetic Google): `server/test/gmailApplicationUpdatesDb.test.ts` (Room enabling,
  audience recheck, private execution, structured notice without mail text or private applications,
  content-free Room listing and pausing; the combined card with reuse and independent pausing; delegation
  from card to scoped read, scope-escape refusal, owner audit and count, revocation between Gmail's answer and
  release, member removal before the next send, opt-out ending; a result of a failed delivery posted once by
  the next success, only for applications still shared and while the Room's readers read the Project; a reader
  outside the Project joining a Room between two sends of a delegated read; digest reuse only on the same
  conversation, time, time zone and configuration, otherwise changed in place; two replacement cards accepted out
  of order and a card stale after `.set_time`; a waiting result never posted after re-carding to another Room),
  `remoteProviderBindingFrame.test.ts` (a daily or rule digest Run's lease pinned to its card's model),
  `gmailMonitorSyncDb.test.ts`
  (digest card naming its configuration, refusal of a changed binding, pause at start without a Gmail request,
  no generic resume, in-place reconfirmation, legacy digest pause; a profile switched in place pausing before a
  Run is queued, and a dropped option, another Provider or a switched model reading and delivering nothing),
  `gmailRoomReadAcceptanceDb.test.ts` (a Room digest's confirmed model applied strictly by the live session),
  `GmailConnectionsCard.test.tsx` (delegation list and revoke, no resume for a runtime-paused digest).
- Not covered: real acceptance with a Google project, a live mailbox and live runtimes; whether a model
  classifies mail correctly; whether Gmail's parser treats every operator inside a parenthesized scope as the
  owner intends (the server guarantees only that the member's words cannot leave the group).
