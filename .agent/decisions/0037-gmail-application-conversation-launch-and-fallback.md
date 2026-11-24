# ADR 0037 — Gmail application updates run as the owner's conversation runs; an explicit fallback stops the round

Date: 2026-11-23
Status: accepted (the owner's confirmed design). Implemented in the workspace branch with synthetic mail on real
PostgreSQL and synthetic Host frames; no real mailbox, Google project, live runtime, live strict Host daemon or live
rule has been used.

## Context

ADR 0034 §3 and ADR 0036 (§1, §8–§11) let an application-update automation run only on a configuration that could
*prove*, before any mail was released, which model answered it: a runtime whose adapter reported the model of its own
responses (in practice only Claude Code), pinned to a full model id, or a ModelProvider configuration launched
isolated to its lease on the built-in strict Host (in practice only OpenCode there). Every other configuration the
owner uses every day in conversation — Codex CLI on its own login, a picker alias, the runtime's default — was listed
on the card as unavailable, and a provider-bound automation needed its own launch path, settlement rules and upgrade
repairs. The owner asked that the card offer exactly what their conversation offers and launch it the same way; that
a missing proof of the answering model block nothing; and that only the CLI's own explicit report of a fallback stop
the round, with one notice, saying plainly what could no longer be taken back.

## Decision

1. **The card offers the conversation's options.** A configuration is still an Agent the owner may use in the Project
   with one runtime profile their own private conversation of it can run (`listOptions` for the owner: Host ownership,
   liveness, installation; ADR 0036 §1, §8). Its models are exactly what that conversation's model picker offers, in its
   order and with the runtime's own names (`GmailApplicationExecutionModel.name`): a full id, an alias or `default`,
   whatever the runtime; without a picker, the runtime's own default (`default`, no model option). A ModelProvider
   profile offers its lease model, still checked as production checks it (Profile admission, Provider eligibility,
   the lease's own target; `providerConfiguration`). The reasons `model_unprovable`, `model_alias_only`,
   `model_channel_unavailable`, `model_channel_workspace_shared` and the model-level `model_alias` are removed: no
   configuration or model is refused for what it cannot prove. Paging, the two levels, the one check, revisions,
   ownership and every scope gate of ADR 0036 are unchanged.
2. **It launches as the conversation launches.** The automation's turn in the owner's private execution conversation is
   an ordinary unattended private turn (`queueUnattendedPrivateTurn`): the runtime's own launch and egress, a
   ModelProvider's ordinary lease. The Gmail-only model-only channel requirement is removed (`model_channel` in the Run
   contract, `runRequiresModelChannel`, `modelChannelLaunchRefusal`, `launchIsolatedToModelChannel`,
   `modelChannelIsolationSql`, the adapter's channel refusals, `requeueUnisolatedReviewFlags` — kept only to settle the
   previous release's Runs, §10). Shared machinery stays:
   ADR 0030 §4a's isolated launch for sensitive plugin tools (`selectModelChannelLaunch`, `runSelectsModelChannel`) and
   ADR 0036 §11–§16's vendor-session safety (an isolated session is never resumed with network, channel-split CLI
   directories, resume verdicts under the thread lock, Host-reset fences), which serve every conversation.
3. **Nothing switches silently; no proof is asked.** The frozen configuration is still applied strictly (`pinnedSessionConfig`,
   the lease held to the chosen model, `gmail_application_model_required`), and the read, every Gmail send, the release,
   each fact and each flag still require the Run's frozen profile, runtime, Provider, launch-bound lease model and
   session options with nothing dropped, for the request's own current launch (`applicationUpdateRunState`, which
   reuses `digestRunOnConfirmedRuntime`, the rule a daily or rule digest already had, ADR 0035 §3). No proof of which
   model answered is read, awaited or required, at the read, the release, a fact or settlement; `runtimeModelProof.ts`,
   and the proof wait are removed; `run_attempts.model_proof_json` stays as an idle column (§10). A model the owner
   switches to on a new card is frozen on acceptance; the earlier round's Run is of another rule version and reads,
   records and settles nothing more (ADR 0034 §1, unchanged), and the next round runs on the new choice.
4. **Only an explicit fallback report stops a round.** A runtime whose ACP adapter states a fallback declares it in its
   adapter catalog entry (`model.model_fallback_notice.notice_title`): today `claude-agent-acp`'s
   `model_refusal_fallback` warning notice and `codex-acp`'s `model/rerouted` notice. The ACP controller reports such a
   notice on the main session of this launch's prompt (never a resumed session's replay or a child session;
   `on_model_fallback`), and the Host adapter records the Run's first report on the Run
   (`model_override_json.runtime_model_fallback`, `recordRuntimeModelFallback`), so a relaunch of the same attempt does not
   lose it. Nothing else is a fallback: a missing model, an echo, a response id spelled otherwise (an alias, a dated id),
   a usage row naming another model, or another notice. From the report on, the round stops (`applicationUpdateRunState`
   `fallback`): the read refuses with `gmail_digest_model_fallback` (telling the Agent to end its turn), every further
   Gmail send, release, fact and flag is refused.
5. **The round's results are not pushed; the owner gets one notice.** Settlement of such a round (`settleFallback`) does
   not post the Agent's reply nor the shared results it recorded (they are deleted unposted, as for another card); it
   delivers one fixed notice instead, through the reply's own delivery, into the owner's private execution conversation
   (the existing feedback, stop and notification path: the delivery fails with `gmail_digest_model_fallback`, the
   automation's `last_error_code` shows it on Sources → Gmail, its failure count pauses it after three such rounds in a
   row). The notice says what the runtime reported, that nothing more was read or recorded and nothing was posted, how
   many messages had already been handed to the Agent, and that what was handed out before the report — that mail and any
   application update or review flag recorded from it — stays and cannot be taken back. No message counts an attempt or
   is marked done: the next round reads them again on the chosen configuration (a fact recorded from one replays its
   earlier outcome).
6. **Earlier authorizations are kept, never widened.** A ModelProvider automation confirmed while such a configuration
   launched isolated to its lease (ADR 0036 §9–§11) would now run with its runtime's ordinary network: it is paused
   (`gmail_digest_launch_reconfirm_required`) until the owner accepts a new card, which says how it runs now and changes
   the same automation in place. New bindings carry `conversation_launch: true`; a pending card that froze a ModelProvider
   binding without it shows no saved choice and is refused at acceptance until the owner chooses again on it. A Run
   started for an isolated launch (`model_channel` in its contract) is of an earlier rule and reads nothing
   (`applicationRunUnderCurrentRule`, `APPLICATION_RUN_CURRENT_SQL`). Runtime-native automations confirmed earlier wait
   for a new card too: dropping the proof widened what their card promised (§7, a review amendment). The card's text now
   states the launch and the fallback behaviour.

## Review amendments (2026-11-23)

7. **Every earlier authorization waits for a new card, native ones too.** Item by item, a runtime-native automation
   confirmed under ADR 0034/0036 keeps its Agent, runtime profile, model id, session options, mailbox, effects, audience
   and ordinary network; but its card promised that mail is released only once the runtime proved the answering model,
   and now mail is released with no proof, a fallback stops only what comes after its report, and what was handed out
   is not taken back. That is a wider commitment than the owner accepted, as an isolated ModelProvider's is. So any
   binding without `conversation_launch`, whatever its backend, is refused at acceptance, pauses its automation
   (`gmail_digest_launch_reconfirm_required`) and makes every Run of it of an earlier rule
   (`applicationRunUnderCurrentRule`, `APPLICATION_RUN_CURRENT_SQL`): a queued round is never claimed, a running one
   reads, records and flags nothing, and its settlement is a rule change (no reply, no attempt counted) — whether or
   not its contract names `model_channel`, which Runs queued before that field existed do not.
8. **A fallback counts from its receipt.** The Run-row write can wait behind the step it must stop (a Gmail release
   holds the Run `FOR UPDATE`, a fact or flag `FOR SHARE`) and must not queue behind the display observations. The
   receiving process notes the report before awaiting, writes it on its own chain (`launchModelWrites`), and every check
   reads that note first (`runModelFallback`) until the row commits; a failed write keeps the note for the process.
   Another server process sees it from the commit. A retried settlement returns the same one notice (unique per Run),
   keyed on the failed delivery's own `gmail_digest_model_fallback` code, never on the report still being readable.
9. **A switch or a fallback uses the conversation's own session mechanism.** A retained native session that its last
   turn left on another model, or that reported a fallback (`claude-agent-acp` says the session continues on the
   fallback model), would otherwise hold the strict switch for a handoff every round. Before a round is queued it is
   switched in place when `canSwitchRetainedSessionModel` allows, else reopened through the owner's own context reset
   (`reopenRetainedSessionForChoice`, `resetConversationAgent` of exactly that session), refused as that reset refuses
   it: never while a dispatch holds the thread, never on another person's Host.
10. **No migration in this change; the proof column stays idle.** The unpublished draft migration that dropped
    `run_attempts.model_proof_json` (and its check) is not part of this change: dropping it while the previous release still
    writes and reads it at every automation read would need a maintenance drain, and that drain would have to let the
    previous release settle its own rounds. So the column and `ck_run_attempts_model_proof` stay in the schema with no
    reader or writer (dropping them is a later, separate migration); a relaunch still clears another launch's value
    (`bindAttemptLaunch`), so an attempt the previous release proved can be relaunched without breaking the check. An
    ordinary update then stops the previous server with rounds in flight, and this release settles them compatibly: a
    Run this release starts carries `conversation_launch: true` in its contract, and a Run without it — the previous
    release's — gets that release's settlement repair first (`requeueLegacyUnisolatedReviewFlags`, ADR 0036 §11:
    review flags an unisolated ModelProvider launch made go back to waiting, judged per read log exactly as before),
    then ends as a rule change (§7). A Run this release started never gets the repair: its ordinary launch is the
    authorized one. The published migration history and checksums are unchanged.

## Review amendments, second round (2026-11-23)

11. **Where a fallback stops a step: its commit boundary.** A Gmail release, a fact and a review flag each check for a
    report and then still wait on SQL (locks, statements) before they commit; a report received in that gap must not
    let the step commit. Each holds the Run row from its check to its commit (the release `FOR UPDATE`, a fact or flag
    `FOR SHARE`; `runModelFallback` with `lock`) and registers a commit guard (`stopAtCommitOnModelFallback`, on the
    transaction helpers' boundary `guardTransactionCommit`, `db/tx.ts`) that reads this process's note synchronously
    immediately before `COMMIT` is issued: a report noted before then rolls the step back (the release is withheld, the
    fact refused, the flag refused). A report another process receives commits either before the step's row lock, and
    the step's check reads it, or after the step's commit, since its Run-row write needs that row. Nothing is promised
    beyond the boundary: a step whose `COMMIT` was issued has handed out its result — mail reaches the Agent only from
    the release's commit — and it stays, counted in the owner's notice; nothing already sent to Gmail, the Agent or the
    record is withdrawn. A Gmail fetch itself hands nothing out: its mail reaches the Agent only through the release.
12. **The shared session resume and reopen cover an alias and a configuration without a picker.** A resumed session
    that already stands on the one advertised choice the requested picker alias names (the adapter resolved that alias
    to its canonical value on an earlier turn) is on the requested model: the ACP controller resumes it as it is
    instead of refusing it for a handoff when it may not switch models (`allow_resumed_model_change: false`, a full
    context) — every conversation, not only Gmail. An alias naming no or several advertised choices is still sent or
    refused as before. Before a round is queued (§9), a session whose last turn reported a fallback is reopened whether
    or not the binding has a picker — without one nothing switches it back, and a Claude launch still sends its
    conversation default, which a full session on the fallback model would refuse every round; a change between a
    picker model and none is a model change like any other (switched in place when allowed, else reopened).
13. **The combined card never reuses an authorization awaiting a new card.** `source.gmail.setup.propose` lists an
    application automation as already allowed only when its binding carries `conversation_launch` (§6, §7); an earlier
    one, still active until its next start pauses it, is drafted again as a part that changes it in place.

## Review amendments, third round (2026-11-23)

14. **The previous release's repair also applies where a delivery is ended before it settles.** A start (the
    scheduler), a new card, a pause or an end can end a running delivery of a Run the previous release started before
    that Run settles (`stopDigestDelivery`); its settlement then finds the delivery failed and returns without the
    repair, so a review flag its unisolated ModelProvider launch made would hold that mail forever. `stopDigestDelivery`
    therefore applies `requeueLegacyUnisolatedReviewFlags` itself, in the transaction that marks the delivery failed, to
    each application delivery it ends whose Run lacks `conversation_launch` — with the binding as it stood before the
    caller changes it. The repair is unchanged: only `review` mail of that delivery whose every read log of the Run is
    determinably an ordinary launch's goes back to `pending`; a delivery already settled, a Run this release started,
    a log of an isolated, unknown or missing launch, facts, `done` or `failed` mail, audits and read logs are not
    touched. It is idempotent: a repaired message is no longer `review`, and the later settlement or another stop
    finds nothing to end. The requeued mail is read again by the next round (after a new card, the start that follows).

## Consequences

- Amends ADR 0034 §3 (no proof of the answering model; the configuration is still applied strictly) and §7 (no
  `gmail_digest_model_unproven`), and ADR 0036 §1 and §8 (what the card offers), §9–§11 (the Gmail model-only launch,
  its settlement and upgrade repairs are removed; shared session safety stays), and §12–§16 only in that they no longer
  have a Gmail-specific isolated launch to protect. ADR 0033 §6 holds again for every Gmail tool's Run: it runs on the
  conversation's own runtime.
- Privacy trade-off, stated: with no isolated channel, mail handed to a ModelProvider configuration is as reachable to
  its runtime as in an ordinary conversation that reads Gmail (ADR 0033); the owner chooses that configuration on the
  card. Owner-only audience, mailbox and effect scope, Host ownership, Project admission, consent and revision binding
  are unchanged.
- An explicit report arriving only after the round's results were settled cannot be acted upon; reports arriving after
  mail was handed out or a fact was recorded stop the rest and are named in the notice. A runtime that reports no
  fallback, or reports it in a way its catalog does not declare, is never stopped.
- Code: `runs/runtimeModelFallback.ts`, `runs/cliConversationProtocol.ts` (`on_model_fallback`),
  `runs/remoteHostCliAdapter.ts` (`observeModelFallback`), `runtimeAdapters/specs.ts` (`model_fallback_notice`),
  `runs/modelChannelLaunch.ts`, `agents/chatOperations.ts`, `hosts/threadEventNormalization.ts` (a notice's fields on the
  update itself, so the runtime's fallback notice shows in the turn), `sources/gmail/gmailApplicationExecution.ts`,
  `gmailApplicationUpdateRuns.ts` (`applicationModelChoice`, `applicationExecutionKey`, `applicationUpdateRunState`),
  `gmailDigests.ts` (start, `settleFallback`, `gmailFallbackNoticeText`), `gmailDigestReadOperation.ts`,
  `gmailApplicationUpdates.ts`, `gmailSetupProposal.ts`; `db/tx.ts` (commit boundary), `runs/repository.ts`
  (idle proof cleared on relaunch); protocol `gmail.ts`; no migration; web
  `GmailApplicationExecutionChoice.tsx`, `GmailConnectionsCard.tsx`, i18n.
- Tests (third review round): `gmailApplicationUpdatesDb.test.ts` `ADR 0037 §10 review` (a previous-release round
  ended by `startDueGmailDigests` before its settlement: its flag waits again in that transaction, the automation
  paused for a new card, the fact, audits and read logs kept, the later settlement and an end changing nothing; one
  ended by an accepted new card: repaired at acceptance and taken by the next round, while a round this release started
  and a new card ended keeps its flag).
- Tests (second review round): `gmailApplicationUpdatesDb.test.ts` `ADR 0037 §11` (a release, a fact and a flag held
  on a row lock after their check while the report arrives: each refused at its commit boundary, the release's earlier
  commit kept and counted), `ADR 0037 §12` (through the real Host adapter: an alias resolved in a full session resumed
  as it is; a picker-less configuration after a fallback reopened, then resumed), `ADR 0037 §10` (a previous-release
  round settled with its repair, this release's round keeping its flag), `ADR 0037 §7 review` (the combined card drafts
  a legacy automation again); `acpModelSelection.test.ts` (resumed alias already on its choice; ambiguous or other
  choices still held); `acpModelFallback.test.ts` (the commit guard: rollback, cleared per transaction, refused without
  a boundary); `migrationMaintenance.test.ts` back to its earlier chain.
- Tests (review amendments): `gmailApplicationUpdatesDb.test.ts` `ADR 0037 review` cases (a legacy ModelProvider
  automation's queued and running rounds without `model_channel`, a legacy runtime-native automation and its pending
  card; three rounds through the real Host adapter — in-place switch, a reported fallback, reopen of a full session),
  the settlement retry in the fallback case, `acpModelFallback.test.ts` (fallback write not queued behind blocked
  observations; read from receipt before the row commits).
- Tests: `server/test/gmailApplicationUpdatesDb.test.ts` (`ADR 0037` cases: the conversation's picker with aliases,
  `default` and no picker, read and settled with no proof; Codex CLI on its own login chosen, accepted, scheduled, routed,
  read, a fact recorded and settled; a model switched on a new card; an explicit fallback after mail and a fact were
  handed out, then rounds until the pause; a legacy isolated ModelProvider automation paused, its isolated Run refused, an
  old card chosen again; the OpenCode Provider case on the conversation's launch with the lease held to the model),
  `acpModelFallback.test.ts`, `remoteHostCliAdapter.test.ts` (a notice frame recorded for its launch); web card and
  Sources tests; Chromium `conversation-layout.browser.mjs` (Room card in both themes and locales at 390 and 1280 px).
- Not covered: live runtimes and their real fallback notices (the notice titles are taken from the pinned adapter
  sources, `claude-agent-acp` 0.101.0 and `codex-acp` 2.5.0), a live Host, a live ModelProvider, a live Google project or
  mailbox. The CLI is not killed mid-response on a report: its later Gmail tools are refused and nothing it says is posted.
