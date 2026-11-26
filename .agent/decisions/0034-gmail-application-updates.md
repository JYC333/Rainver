# ADR 0034 — Gmail: automatic application updates from new mail

> The former `applications` package is now
> [PhD Application](../architecture/OFFICIAL_OPTIONAL_MODULES.md#phd-application-package)
> (`phd_application`). This ADR uses the package, tool and schema names from
> the time of the decision.

Date: 2026-11-21
Status: accepted. Implemented in the workspace branch with synthetic mail on real PostgreSQL;
no real mailbox, Google project or live rule has been used.
[ADR 0035](0035-gmail-shared-project-scope.md) §1 amends §2 and §8: the owner may also enable and manage the
automation from a Room or the mainline whose readers all read the Project; it still runs in an owner-only
(private execution) conversation, and only structured results on applications the Project reads are posted
to the enabling conversation.
[ADR 0036](0036-gmail-application-execution-choice.md) amends §2 and §3: the owner chooses the Agent and model on the
card among those that can run it in the background (not the asking conversation's binding, which no longer blocks
drafting), and every automation runs in the owner's private execution conversation bound exactly to that choice.
[ADR 0037](0037-gmail-application-conversation-launch-and-fallback.md) amends §3 and §7: no proof of the answering model
is required anywhere (the configuration is still applied strictly), and only the runtime's explicit fallback report
stops a round, whose results are then not posted and whose owner gets one notice.

## Inbox and sent-mail coverage

The application-update card covers new inbox and sent mail in one confirmation
on the already-connected mailbox. Both use the same matching, facts, review,
deduplication, delivery and settlement. A card that allows `contact` can record
an email event on the matching application in either direction. The verified
direction sets the event's direction and keeps institutional facts grounded in
received mail. Email addresses learned here stay in the owner's contacts.
Shared notices can report the event on a shared application with its direction
and without contact identity or message content. Earlier cards retain their
accepted effects and coverage. An update card can add `contact` in place.
Newly enabled sent coverage starts at acceptance.

## Context

The owner asked that new Gmail mail update their Applications without a keyword pre-filter
("Quick chat" from a program can be an interview invitation), without confirming each message,
and without a second Gmail authorization or a settings page: one confirmation of the rule in the
conversation they are already in, run by the Agent and model they choose, with pause and change in
conversation. [ADR 0033](0033-gmail-project-consent-and-private-delivery.md)'s monitors match only
headers and its digests only summarize; [ADR 0030](0030-plugin-agent-data-access.md) §7 lets an
on-demand read feed Applications only in the owner's own `manual` turn. A scheduled Run that reads mail
had no write at all.

## Decision

1. **A digest kind, not a new authority.** The automation is a Gmail digest of kind `application`
   (`gmail_digests`), confirmed on the same owner-only `gmail_digest_create` card in the mailbox
   owner's own `manual` turn. Acceptance writes the automation with a `core:gmail_digest` Project
   consent of purpose `application_update` on the connection the owner already opted in (no new
   OAuth, no new consent kind); it ends with every ADR 0033 §4 ending, with pausing, ending or a
   lost audience as a digest does. A later card for the same mailbox and Project changes the same
   automation in place (effects, Agent, model, conversation; a paused one resumes from now) and keeps
   its ledger. Pausing and ending are narrowing and need no card; resuming or widening is a card — also
   from Sources → Access and Gmail, where the generic digest status command refuses to resume this kind.
   Each delivery carries the rule version it was started for (the accepted card's id, in its Run's
   immutable `gmail_digest.rule_version`); a new card ends a delivery still running under the earlier
   version (`gmail_digest_rule_changed`), and its Run's reads, sends, facts, flags and settlement are refused
   from then on. Its messages wait for a delivery of the new version.
2. **Only the owner reads it.** The conversation must be the mailbox owner's own private conversation of
   the Project — never a Room or the mainline, even while nobody else reads it, because a Room's stored
   history is shown to whoever joins it later — at drafting, acceptance, start,
   the Run's claim, every Gmail send, read release and settlement (`gmailDigestConversationAdmits`
   with `ownerOnly`; refusal `gmail_digest_audience_not_owner`). The Run's reply in that conversation
   is the reminder, so only the owner is reminded; nothing is posted anywhere else.
3. **Pinned Agent and model.** The card freezes the conversation's binding for its Agent (runtime
   profile, runtime, backend mode, provider and model, session configuration) and the one explicit model
   it resolves to (`pinned_model`: the bound ModelProvider's model as its lease resolves it, or the
   conversation's explicit model option), and shows the Agent and that model. "The runtime's default
   model" is never confirmed: it can move from one model to another without the binding changing, so a
   conversation without an explicit model cannot draft (`gmail_digest_model_unresolved`), a card without
   `pinned_model` is not accepted, and an automation frozen without one waits
   (`gmail_digest_runtime_changed`) for a new card. A delivery starts only while the conversation still binds exactly that; otherwise it waits
   (`gmail_digest_runtime_changed`) until the owner confirms a new card. Mail is processed by that
   runtime's model on the conversation's own runtime (ADR 0033 §6); the credential stays on the server.
   The confirmed session options are applied strictly (`pinnedSessionConfig`): when the runtime no longer
   offers the confirmed model the delivery does not start (`gmail_digest_model_unavailable`) — except that
   Claude Code leaves a saved model missing from the Host's cached picker, which can be stale, to its live
   session — and when the live session does not apply it the turn fails — never continuing on the runtime's
   default model; such a failure counts no attempt on the mail (§7). The
   digest read releases mail only to a Run whose runtime profile, runtime, applied session options and
   provider are the frozen ones with nothing dropped and whose actual model is proven to be the confirmed
   one (`applicationUpdateRunOnPinnedRuntime`): a provider-bound Run's launch bound exactly that model
   (`model_override_json.model`, `source: runtime_profile`), and a runtime-native Run's live launch was
   answered by exactly that id and no other (`run_attempts.model_proof_json`, `runs/runtimeModelProof.ts`).
   That proof is an actual-model event of a response to the launch's own prompt — Claude Code's main-session
   `_claude/model`, which `claude-agent-acp` takes from the API's `message.model`, accepted only while this
   launch's `session/prompt` is in flight, never during `session/resume` replay or from a child session —
   and is distinct from `runtime_reported_model`, which also carries the model option's echo
   (`currentValue`) and stays a display observation. An echo, even one equal to the confirmed id letter for
   letter, proves nothing. The proof is written only for the attempt still bound to that launch nonce (a
   CHECK ties it to `launch_id`; rebinding the attempt to another launch clears it), so a restart or a late
   write of an earlier launch never proves the current one; models only accumulate, so a launch answered by
   a second model (a fallback) stays disproven. It is compared verbatim: no runtime reports a verifiable
   alias→model mapping, so a different model sharing its prefix, a dated, tagged or re-cased variant, or a
   canonical id merely containing the confirmed alias proves nothing. Because the proof is the full id a
   response reports, an alias of the runtime's own option space (Claude Code's `opus`, `sonnet[1m]`, …:
   `runtimeModelSelectionIsAlias`, judged from the adapter catalog's `acp_model_aliases` and the value's
   shape, never a server-owned alias table) could never be proven, and no ACP option field carries what it
   resolves to; such a pin cannot draft (`gmail_digest_model_alias`, naming the full ids the conversation's
   picker offers now), such a card is not accepted (409 with the same guidance) and such an automation does
   not start (`gmail_digest_model_alias`, shown to the owner). The guidance is to select a full model id in
   this conversation, or to bind the Agent to a ModelProvider with a fixed model from a new private
   conversation of the Project (a started conversation keeps its runtime and backend; the card there updates
   the automation in place); the proof itself is unchanged. Every check is for the launch the tool request
   came from — each launch generates its nonce first and issues its Run tool token with it, stored together in
   one statement, and a token resolves only with that launch (never the one the attempt names when the request
   arrives; a token without one does not resolve) — and only while it is still the Run's current launch: a
   request of an earlier launch, or of a new one not yet bound on the attempt, is never admitted on another
   launch's proof or lease. It is rechecked before every Gmail send, so a relaunch stops a read before its next
   message, and the release, each fact and each flag hold that attempt until commit, so a relaunch waits for
   them. The release is recorded for that launch, and a fact or flag cites only mail released to its own
   request's launch. The digest
   read waits, outside its transaction and bounded (20 s, ending early when its launch is replaced), for its
   launch's proof before it fetches any mail (its response can trail the tool call it made) and is otherwise
   refused (`gmail_digest_model_unproven`); the wait, the Gmail page and the release share one 55 s budget
   from the request's arrival, inside the CLI and Host tool timeout of 65 s: a page it ends is 504
   `gmail_upstream_timeout`; the release holds the budget's absolute deadline up to its commit boundary (each
   statement's lock wait and run time are cut to what is left when it starts, so successive waits never add
   up past it; the deadline and the caller's abort, also one during its first statement, cancel the statement
   in progress), and a release past the budget or for a caller that went away commits nothing (no audit, read
   log or read progress). The release gate and every fact
   recheck the proof exactly, without waiting (a fact needs a released read). The proof is written apart from
   the display observation's Run-row write, never queued behind it. A runtime that
   reports no such event before a tool call — Codex reports only `currentValue`, its `usage_update` names no
   model and its per-model usage arrives with the prompt's final result; OpenCode and the others likewise —
   cannot prove its model, so a native binding on it cannot draft (`gmail_digest_model_unprovable`, said
   before asking for an explicit model, which would not help), such a card is not accepted (also one frozen
   without `pinned_model`), and such an automation does not start (`gmail_digest_model_unprovable`, shown to
   the owner). Unproven, missing or another model releases nothing. The Run's
   contract carries the confirmed model (`gmail_digest.pinned_model`), and a provider-bound automation
   Run's lease is built only for exactly it and held to it (`pinned_model`; a Provider whose default moved
   to another model, or no model, mints no lease).
4. **Every covered message, semantically.** The mailbox sync records, for each active automation in
   the version it checked (`covered_until`), new INBOX and authorized SENT messages. It excludes SPAM,
   TRASH, DRAFT and CHAT and applies the card's coverage timestamps. It stores ids and receipt times only
   (`gmail_digest_mail_items`). The scheduler starts one automation-origin Run per batch (at most 20
   messages, oldest first, then a 10-minute batching interval) whose snapshot holds exactly
   `source.gmail.digest.read` (its frozen messages), `plugin.applications.application.list`/`.get`,
   `plugin.applications.mail_fact.apply` and `source.gmail.application_updates.flag`. The Agent judges
   each message's meaning; mail text is untrusted data.
5. **Structured facts, checked twice, written by the owner of the data.** The Agent submits one
   fact per call — an external result (`under_review`, `interview`, `waitlisted`, `offer`,
   `rejected`), `submission_received`, `deadline` of a kind with its date, or `contact` — for one explicit
   `application_id`, with `expected_revision` and its source (message id and its exact receipt time).
   - The **host** (`gmailApplicationFactAdmitted`) admits only the running delivery's Run of the owner's
     active automation, in the targeted Project, while its consent and owner-only audience admit it, for
     a message frozen for that delivery, released by its read to this request's launch and received exactly then,
     for an effect the rule allows, on the frozen runtime and model, under the rule version in force, and
     when every other sensitive read the Run holds is the owner's own mail of this Project: an on-demand
     read the owner made earlier in the same private conversation (inherited taint) counts only with its
     verified `gmail_scope` for this Project and a still-live `core:gmail` consent; a read of unknown or
     another owner, another source or Project, or personal Memory keeps the write refused. Everything else — a
     person, an ordinary turn, another Run or message — is the hidden 404. The gate locks in the order of
     every Gmail writer (person and Run `FOR SHARE` from the operation core's actor pin → owner + Space
     mutex → connection → digest), and reads the Run's taint `FOR SHARE` (never upgrading the pin), so
     concurrent facts of one Run, a disconnect, a reconnect or a new card either commit first and are seen,
     or wait until the fact has committed. The fact takes its Project `FOR UPDATE` before that pin, the
     order of the digest read's release (Project → person → Run), so a fact of one page and the release of
     the next page of the same Run never deadlock; every Agent release of a Project-bound plugin result (the
     same Run's `application.list`/`.get`) takes its Project first too, and so does every other Project-bound
     command of an Agent (`application.update` and the rest of the package, before its own actor pin) and
     every core Task and Board command of an Agent in its Run's Project (`task.create`, `task.update`, the
     Task-addressed actions, `board.configure`, `task.move_to_column`; `lockBeforeActor`, after the idempotency
     reservation and before the actor pin), so an
     ordinary write never holds the Run while waiting for a Project such a release holds. This is the one write a
     mail-tainted scheduled Run may make; ADR 0030 §7's outward refusal stands for every other write.
   - The **package** (`mail_fact.apply`) decides against current state, under the application's row lock:
     replay of the same message, effect and application returns its first outcome; an archived
     application or another revision writes nothing (the revision conflict is not stored); a status
     moves only forward (`EXTERNAL_RESULT_RANK`), never from a person's decision and never over a status
     that became true after the message was received (`status_changed_at`: the person's change, the
     message's receipt time, the epoch for a new record's initial status); a deadline is added (without a
     Task) or the one deadline of that kind is moved, never over a date set after the message
     (`date_changed_at`); several of that kind is a conflict. An email event uses the uniquely matched
     linked contact or creates an owner-private linked contact. It stores the message date, verified
     direction and fixed text. Ambiguous matches go through the same review flow.
     Every outcome but a stale revision is kept
     in `plugin_applications.application_mail_facts` (ids, values, codes; never mail text).
6. **Out of automation's reach.** Accepting, declining or withdrawing, any other status, archiving,
   deleting, unlinking, general contact edits, notes, links, Tasks and sending mail are never automatic. They stay
   with the person (decisions remain approved proposals).
7. **Ambiguity is isolated, failures are bounded.** A message that may concern several applications,
   matches none, is unclear, or conflicted is flagged for the owner (`review`, at most five candidate
   application ids) instead of guessed; a flag is held to the fact's checks of runtime, model, launch,
   consent and audience. A successful delivery marks `done` its other messages released to the launch
   that finished; one only an earlier launch read stays pending for the next delivery. A frozen message
   that is spam, trash, sent, a draft or a chat by the time it is read is withheld from the Agent and
   settled with that read as examined and not eligible (`done`, `not_eligible`), never as released mail, so
   it can neither be cited by a fact or flag nor keep waiting. A frozen message Gmail answers with an
   explicit 404 is skipped by that read and given up by its release (`failed`, `read_failed`, no attempt),
   never released, so it is uncitable and neither blocks the batch's other mail nor pauses the automation;
   any other Gmail failure (5xx, 429) still fails the page and is retried. A failed delivery
   counts an attempt only on each waiting message actually released to a launch of its Run (so read by the
   confirmed model); one at three attempts is given up alone (`failed`, `read_failed`) so the others go on.
   Mail the model never had — the live session did not apply the confirmed model, the launch never started
   (`gmail_digest_model_unproven`), or it failed before reading that message — counts no attempt; the
   digest's own pause after three consecutive failures still applies. A delivery ended by its rule — a new card, a Run started before
   deliveries carried a version or the confirmed model (an upgrade), or an automation frozen with a binding
   that could never be proven — is no failure of its mail: its Run is not claimed, it counts no attempt and
   no failure even when the consent ended meanwhile, its messages stay pending, and the next start ends any
   such delivery still running before starting one of the current version; the scheduler judges a running
   delivery's binding by the same rule, so one that could never be proven never holds it. Settled rows are pruned after 30 days.
8. **Conversation management.** `source.gmail.application_updates.propose`, `.list` (content-free:
   status, effects, Agent and model, per-message outcomes with Gmail links and application ids) and
   `.set_status` (pause or end) are conversation tools admitted only in the owner's own turn in their
   private conversation; `plugin.applications.mail_fact.list` shows the owner what was recorded — to the
   owner directly, or to an Agent only in a Run of the owner's private conversation of that Project whose
   whole audience is the owner (`gmailApplicationFactsAudienceAdmitted`, the hidden 404 otherwise; rechecked
   at release). What the ledger and `.list` return is the owner's mail's: an Agent Run that receives either
   records a sensitive read of it (`core:gmail_digest`, the owner's) in its taint even if it never read
   Gmail, so its outward writes are refused and later Runs of that conversation inherit it, and both calls
   are reduced in event logs (`privateToolCalls.ts`).
   Because each widens nothing and publishes nothing to anyone else, they — and the automation Run's
   flag — are exempt from the outward-write refusal after a mail read, so the owner can set the rule up
   in the conversation where they just read mail. The general Applications writes are not exempted.

## Consequences

- Amends ADR 0030 §7 (one dedicated, host-gated write for a scheduled Run that read the owner's mail)
  and ADR 0033 (a third digest kind with an owner-only audience and a pinned runtime); every other rule
  of both stands.
- Code: `server/src/modules/sources/gmail/gmailApplicationUpdates.ts`, `gmailApplicationUpdateRuns.ts`,
  `gmailDigests.ts`, `gmailMailboxSync.ts`, `gmailDigestReadOperation.ts`, `gmailSyncRequests.ts`,
  `plugins/egress.ts`, `plugins/operationRegistry.ts`, `runs/repository.ts`,
  `systemActions/scenarioToolAllowance.ts`, `runtimeAdapters/privateToolCalls.ts`,
  `sessions/sessionConfig.ts` (`pinnedSessionConfig`), `agents/chatOperations.ts` (the unattended turn's
  pinned options), `runs/remoteProviderBinding.ts` (the pinned lease model), `runs/runToolRequest.ts` and
  `runs/runToolIdentityRepository.ts` (the request's launch), `runs/runtimeModelProof.ts`,
  `projects/access.ts` (`lockAgentProjectBeforeActor`, used by `plugins/operationRegistry.ts`, `tasks/operations.ts`,
  `projectWork/taskLifecycleOperations.ts` and `projectWork/boardOperations.ts` through the operation core's
  `lockBeforeActor`, `systemActions/operations/executor.ts`), `contentAccess/agentReads.ts` (the release's
  launch); package
  `plugins/official/applications/` (`domain.ts`, `operationManifest.ts`, `schema.ts`,
  `server/src/index.ts`, migration `0000_applications_and_mail_facts`); core migration
  `0021_application_correspondence_and_workspace`; protocol `gmail.ts`; web `GmailConnectionsCard.tsx` and i18n.
- Tests: `server/test/gmailApplicationUpdatesDb.test.ts` (synthetic mailbox, real PostgreSQL: owner-only
  drafting, acceptance, no-keyword recording, refusals of the gate, replay, revision, ordering, the
  person's later change, flag, settlement, listing, pause and change, pinned model, failure isolation,
  ending, and the review regressions: an earlier on-demand read in the same private conversation, an
  unavailable or replaced model, a changed rule version, a Room only the owner reads, the ledger's
  audience, no generic resume), `remoteProviderBindingFrame.test.ts` (pinned lease), `pluginMigrationConversion.test.ts` (old history converts to the shipped chain),
  `applicationsAgentToolsDb.test.ts` (ordinary Runs never carry the fact command),
  `GmailConnectionsCard.test.tsx`; the second review's regressions (explicit model frozen and proven,
  ledger and outcome reads taint, a stale-version delivery ending without an attempt, concurrent facts and
  a racing disconnect) are in the same DB test; an alias pin refused at drafting (with the offered full ids),
  acceptance and start is there too, the classifier in `acpModelProof.test.ts`. The third review's
  regressions are in the same DB test (a token resolving to its launch; a relaunch withholding an earlier
  launch's in-flight read, fact and flag and ending its proof wait; the shared read budget with a late proof
  and a slow synthetic Gmail; a fact of page one racing page two's release; an earlier version's delivery
  settled after a disconnect, a baseline Run without the confirmed model, and an unproven failed delivery
  counting no attempt; the unprovable refusal before the model question and its new-conversation guidance),
  the decoupled proof queue in `acpModelProof.test.ts`. The fourth review's regressions are in the same DB test
  (a token stored with its launch, resolved over real HTTP auth in a relaunch's window; an earlier launch's
  release admitting no fact or flag of a later launch and leaving its mail pending at success; a relaunch
  stopping a read before its next Gmail send; a release blocked past the budget or abandoned by its caller
  committing nothing; the scheduler not held by an unprovable binding; no attempt for a proven launch that read
  nothing or a provider launch that never started; `mail_fact.apply` and `application.get` of one Run without a
  deadlock; the 504 timeout; flags refused after a fallback model, a widened audience or an ended consent).
  The fifth review's regressions are there too: successive lock waits of one release ending at the read's
  absolute deadline, a caller's abort during the release's first statement cancelling its lock wait, and
  frozen mail turned spam, trash, sent or draft settled as not eligible and uncitable. The supplementary
  review's: an ordinary `application.update` racing the same Run's `application.list` release, another
  update's release, and the owner's on-demand Gmail read release, each without a deadlock
  (`applicationsAgentToolsDb.test.ts`, `gmailApplicationUpdatesDb.test.ts`). The sixth review's: `task.create`,
  `task.update` and `task.report` racing the same Run's `application.list` release without a deadlock
  (`applicationsAgentToolsDb.test.ts`), and a frozen message Gmail answers with 404 given up and uncitable
  while the batch's other message is recorded and settled, with a 5xx still failing the page and retried
  (`gmailApplicationUpdatesDb.test.ts`).
- Not covered: whether the model reads a message correctly is its judgment (the server checks scope,
  match, authority, revision and order, not meaning). A Room or the mainline never qualifies. Whether a
  vendor CLI tolerates a model-pinned lease for its side requests is not verified with a live runtime.
  Whether a live Claude Code picker offers a full model id depends on its own model settings (the adapter checked,
  `claude-agent-acp` 0.101.0, normally lists aliases; a native setup then needs the Provider path), and whether the API answers a full id
  with exactly that id (not a dated variant) is not verified live; a mismatch still releases nothing.
  Real acceptance with a Google project, a live mailbox and a live runtime has not
  been performed; no real rule is enabled.
