# ADR 0036 — Gmail application updates: Agent and model chosen on the card

Date: 2026-11-23
Status: accepted. Implemented in the workspace branch with synthetic mail on real PostgreSQL; no real
mailbox, Google project, live runtime, live strict Host daemon or live rule has been used.
[ADR 0037](0037-gmail-application-conversation-launch-and-fallback.md) amends §1 and §8 (the card offers what the owner's
conversation offers: every picker value or the runtime's default, and a ModelProvider's lease model; no proof reasons)
and removes the Gmail model-only launch of §9–§11 with its settlement and upgrade repairs; the shared vendor-session
safety of §11–§16 stays. A ModelProvider automation confirmed under §9 waits for a new card.

## Context

[ADR 0034](0034-gmail-application-updates.md) §3 froze the binding of the conversation the owner asked in
(its Agent, runtime, model and session options) and refused to draft when that binding could not prove its
model (a runtime that only echoes its model option, an alias, no explicit model). The owner then had to change
that conversation, or open a new private one, before a card could even be shown. The owner asked instead to
choose, on the authorization card itself, any Agent they may use in the Project — including the Project's
Assistant, the default when the Project has no Agent of its own — and a concrete model it can run in the
background; to open the card even when the asking conversation's binding cannot run it, with the reason every
unavailable candidate cannot; to see the mailbox, what is read, which application fields may change and who
reads the results before confirming; and to have the background run on that confirmed configuration
independently of the asking conversation, with any change re-authorized. No runtime is preferred or named.

## Decision

1. **Candidates are the existing authorization and runtime facts.** For the mailbox owner in the Project
   (`gmailApplicationExecution.ts`, `applicationExecutionConfigurations`; two levels since §8): every Agent on the Project's list that the owner
   can read, and the Project's own Assistant; for each, every runtime profile the owner can run in their own
   private conversation of the Project (`PgConversationBackendRepository.listOptions` for the owner: Host ownership,
   Host liveness, installation, workspace, Provider eligibility); for each profile, each model whose answer can be
   proven before mail is released (ADR 0034 §3, unchanged): a provider-bound profile's lease model, or each full
   model id the model picker of a runtime that reports the model of its responses offers (`runtimeCanProveModel`,
   never an alias, `runtimeModelSelectionIsAlias`; both judged from the adapter catalog). A model saved for that
   Agent and profile in the asking conversation is offered too (the Host's picker can be stale). A candidate that
   cannot run it is listed with a reason (`agent_unavailable`, `no_runtime`, `host_not_owner`, `host_offline`,
   `runtime_unavailable`, `model_unprovable`, `model_alias_only`, `model_unresolved`) and is never selectable.
2. **The card always opens.** `source.gmail.application_updates.propose` (and the application part of
   `source.gmail.setup.propose`) no longer refuses on the asking conversation's binding. Its default is the
   existing automation's configuration, else the asking conversation's, when either is an available candidate,
   else the first available candidate — the Project's Agents before its Assistant — else none (`runtime_binding:
   null`; acceptance refuses `gmail_digest_execution_unselected`). Every other drafting gate (owner's own turn,
   audience inside the Project, Applications enabled and bound, connection opted in) is unchanged.
3. **The owner chooses on their own card.** `source.gmail.application_updates.execution_options` (query) returns,
   only to the card's owner while it is pending (anyone else: the hidden 404), the scope — mailbox, effects,
   results audience (private, or the Room or mainline with its readers) — the candidates and the choice;
   `.select_execution` (command) rechecks the chosen candidate now (409 `gmail_digest_execution_unavailable` with
   its reason otherwise), and redraws the pending card in place through the proposal subsystem
   (`lockProposalTransitions`, `revisePendingPayload`; a card linked to an operation request is refused): agent,
   frozen binding (that profile and that model option only), the card's text and, for a combined card, the part's
   line (`card_summary`) and the whole card's text (`gmailSetupSummary`). Nothing runs until the owner accepts.
4. **Acceptance rechecks and freezes; the run is independent.** Acceptance recomputes the candidates and refuses a
   choice no longer offered (`gmail_digest_execution_unavailable`, with the reason), then — for every card, also one
   from the owner's private conversation — binds the owner's private execution conversation (ADR 0035 §1,
   `ensureApplicationExecutionConversation`: `resolveBinding` with the chosen profile as the owner, then the chosen
   model option) and requires it to equal the frozen binding. The automation's `session_id` is that conversation;
   the asking conversation's later settings never touch it. Every ADR 0034 gate — owner-only audience, pinned and
   proven model, launch-bound release, fact gate, flags, settlement — applies to it unchanged; a change of its
   binding pauses it (`gmail_digest_runtime_changed`), and another Agent or model is a new card.
5. **Results.** From the owner's private conversation, mail text, the Agent's report and per-message outcomes stay
   in that private execution conversation ("Gmail application updates"); nothing is posted elsewhere. From a Room
   or the mainline, ADR 0035 §1's structured notices are unchanged.

6. **Review amendments (first review).**
   - *The Project's Assistant runs.* The server-started private turn (`queueUnattendedPrivateTurn`) admits the
     Project's own Assistant — only that Project's, only on this entry; the person's own chat stays closed to it — and
     creates its Run with `allow_system_assistant`.
   - *Project admission now, not chat retention.* That turn, the start, the claim, every Gmail send and the release
     (link held `FOR SHARE`) require the Agent on the Project's list (or its Assistant) at that moment; an earlier turn
     in the conversation does not keep a removed Agent admitted (`gmail_digest_agent_not_in_project`). This holds for
     application automations only (amended in §7).
   - *Accept what was shown.* `execution_options` and `.select_execution` return the card's revision (a digest of
     payload and text); acceptance must name it (`proposal.accept` `expected_revision`) and is refused once the card
     changed (`proposal_revision_changed`) or without one (`gmail_card_revision_required`). The web disables Accept
     while a choice is saved and shows only the latest request's answer.
   - *Frozen rule version.* Every application card names the automation it changes and its accepted card
     (`replaces_digest_id` / `replaces_proposal_id`, null for a new one); acceptance refuses `gmail_digest_changed` once
     that is not the live automation — so an older card never overwrites a newer rule nor revives an ended one. A card
     drafted before this names none and is accepted only if no automation was live when it was drafted or since.
   - *Card checks.* The options query and the choice require a pending, unexpired card, the owner's Project read and
     write access, and the asking conversation's audience as shown; a replayed choice is shown only while the owner
     reads the Project. Acceptance also requires write access.
   - *No silent cap.* The Assistant is always listed; at most 50 Project Agents, 20 models per profile and 200 rows,
     available before unavailable, with the remainder counted (`more_candidates`). Every choice is checked by itself.
     (Replaced by paging in §7.)

7. **Review amendments (second review).**
   - *"None" is a version.* A card that changes no automation (`replaces_digest_id: null`, a first card) is accepted only
     while no automation of the mailbox and Project has been live since it was drafted (as an unversioned card): of two
     first cards, the second never starts the rule again after the first was accepted and ended; a card drafted after
     the end does.
   - *Every decision entry shows the choice.* The direct Agent chat decides the card on the card itself (no decision
     handler there); the Proposal detail shows the same choice to the owner and sends its revision; the Proposal list and
     Today offer no Accept for such a card (`chosen_on_card`) and link to the detail. An ordinary summary card is
     confirmed as before.
   - *Project admission is the application automation's.* The private chat's admission (an earlier turn keeps a removed
     Agent) still holds for a private daily or rule digest — drafted, accepted and run alike — which runs on its
     conversation's own Agent (`queueUnattendedPrivateTurn` `projectAdmission`); only an application automation, whose
     Agent is chosen among the Project's, needs the Project's list (or its Assistant) at every start, claim, send and
     release.
   - *Every candidate can be reached.* The list is paged in one fixed order — the Assistant first, then the Project's
     Agents by link order, each with every profile and model — 200 rows and 50 Agents a page; `next_cursor` continues it
     (`execution_options` `cursor`) and the card's "Show more" appends the next page. The cursor names the Agent the next
     page starts at by its sort key (phase, UTC microsecond created or linked, id) and the row within it, never an offset:
     an Agent removed from an earlier page between pages skips no later candidate, and when the named Agent is gone the
     next one starts at its first candidate. The first page also shows the chosen candidate when it is on a later one. The default prefers a Project Agent's candidate on the first page over the
     Assistant's.

8. **Two levels on the card (confirmed design).**
   - *Configuration, then model.* The card lists configurations — an Agent with one runtime profile — and, for the one
     shown, its models. A configuration that cannot run the automation at all carries its one reason and no models; a
     model of an available configuration that cannot be chosen (a picker alias, `model_alias`) is explained under that
     configuration only. The saved choice is echoed on both levels. Paging counts a configuration and each of its
     models as a row and never splits a configuration; the cursor's row is the configuration index within its Agent.
   - *Switching clears.* Choosing another configuration is local: it posts nothing, clears the model and disables
     acceptance until one of its models is saved and the card answers with its revision. Two choices racing on one
     card are taken one at a time (or the second refused as retryable), and only the revision on the card is accepted.
   - *One check.* The default, the echo of the saved choice, a selection and acceptance ask one function for one Agent
     (`applicationExecutionCheck`); a card shows a saved choice only when acceptance would accept it. Acceptance no
     longer runs a separate model refusal before it (a card frozen on an unprovable runtime or an alias is refused by
     that check with its reason), and the conversation-switching refusal text that named one runtime is removed, as are
     helpers without a caller. The per-read release gate (ADR 0034 §3) is unchanged.
   - *Model evidence without a brand in code.* Which runtime proves its model is declared in its adapter catalog entry
     (`model.response_model_proof: { meta_key, source }`); the proof code names none. Models come only from what exists:
     the Host's runtime options, that declared early response-model evidence, or a ModelProvider's fixed-model lease.
     Nothing new is collected or called.
   - *A non-Claude configuration.* A profile bound to a ModelProvider is offered with its lease model and runs through
     the existing fixed-model proxy: its mail is released only to the current launch whose lease bound exactly that
     model; an unbound launch, an echo, another model or an earlier launch's request gets none. (Corrected in §9: Codex
     CLI cannot be bound to a ModelProvider, the lease alone was not enough, and the candidate check is production's.)

9. **Review amendments (third review).**
   - *Only what production admits.* A ModelProvider configuration is checked as production checks it, never by a second
     rule (`providerConfiguration`): Profile admission (`assertBackendModeBinding`; the runtime catalog's
     `credential_mode` decides whether a runtime may be bound to a ModelProvider — today only OpenCode, so Codex CLI,
     Claude Code and Gemini CLI are `provider_unsupported` there, also for a row written around admission), the
     Provider's eligibility for the owner (`isProviderEligibleForUser`, `provider_unavailable`), the lease's own target
     (`providerLeaseTarget`, extracted from and shared with `buildRemoteProviderBinding`: the runtime binds a Provider,
     the Provider is readable as the lease reads it, its vendor protocol is one the runtime speaks —
     `provider_protocol_unsupported` — and it carries that protocol's compatible URL — `provider_endpoint_missing`), and
     the Host (below). The end-to-end case builds its Provider and Profiles through the public commands
     (`provider.create`, `agent.runtime_profile.create`): OpenCode on an OpenAI-compatible Provider on the built-in strict
     Host is the one non-Claude configuration verified; a Codex CLI Provider Profile is refused there.
   - *The lease is not the boundary alone.* A fixed-model lease governs only what goes through the proxy; the runtime
     could otherwise reach anything its egress allows. So a provider-bound automation Run is selected for the existing
     strict Host model-only launch (`selectModelChannelLaunch`, ADR 0030 §4a: built-in strict Host whose daemon reports
     `model_channel`, egress `none`, a `model_only` lease) and passes its pre-launch check (`sensitiveLaunchRefusal`:
     its execution conversation's own CLI state, nothing shared writable). Mail is released — and a fact admitted — only
     when the request's own launch is still current and its launch record, written by the dispatching server with that
     nonce, states that isolation (`launchIsolatedToModelChannel`: `host_kind: server`, `egress_profile: none`,
     `model_channel: provider_lease`); anything else gets nothing. A Host that cannot do this is never offered
     (`model_channel_unavailable`, `hostServesModelChannel`).
   - *Compatibility, stated.* This amends ADR 0033 §6 for this one Run kind (a Project-bound Gmail tool's Run is
     otherwise never selected for the model-only channel and keeps the conversation's own runtime) and ADR 0034 §3 for
     the provider-bound path only (the launch-bound model now also needs the isolated launch). A runtime-native
     automation keeps ADR 0034 §3 unchanged — its launch's own response-model proof, on its runtime's ordinary egress —
     and a Gmail read in an ordinary conversation and a daily or rule digest keep their rules. Nothing is relaxed.
   - *Every model reachable, the saved one visible.* A configuration lists 200 models at a time; `omitted_models` counts
     the rest and `models_cursor` continues them through `execution_options` `models_of` (that configuration alone,
     checked by itself), keyed by the model listed last so a model removed between pages skips nothing. The saved model
     is always listed with its configuration (first, one more, when it falls past the first 200), and the web counts a
     saved choice as shown — and Accept as possible — only while its model is listed.
   - *No refresh undoes an unsaved switch.* Loading a further page or further models disables Accept until it answers;
     the answer is added to what is shown now and brings the card's revision, saved choice and text as they stand (the
     first page too when that choice is not listed yet), and keeps the owner's unsaved switch of configuration.

10. **Review amendments (fourth review).**
    - *What the launch admits, asked as the launch asks it.* A ModelProvider configuration is offered only when its Run
      could be launched on the model-only channel and pass that launch's own pre-launch check, judged by one function
      over the facts the launch reads (`modelChannelLaunchRefusal`, beside `selectModelChannelLaunch`): the built-in
      strict Host reporting `model_channel` (`hostServesModelChannel`, as before), a provider proxy address that Host
      reaches (`hostProviderProxyBaseUrl`, without which `buildRemoteProviderBinding` has no channel URL; else
      `model_channel_unavailable`), and a profile in its conversation's own managed workspace — one bound to a Workspace
      Location launches in that shared, writable folder, which `sensitiveLaunchRefusal` refuses
      (`model_channel_workspace_shared`). Conservative: what stays judged only at launch — the credential-spend policy
      decision on the Run, the lease's own model, the frame's actual workspace and isolation, the resumed vendor session
      — still refuses there; nothing is admitted on a guess.
    - *Recovery matches the launch.* The turn that queues such a Run asks the launch's own selection
      (`runSelectsModelChannel`) and is admitted as a conversation that may read sensitive data: a vendor session pointer
      not bound to an isolated launch of its thread (`sensitiveThreadResumable`) — one an ordinary-egress launch started
      before the upgrade, say — is reset before its context is assembled, instead of the launch refusing the Run
      (`sensitive_resume_unconfirmed`).
    - *An earlier release proves nothing now.* Settlement judges a provider-bound automation's releases by the release
      gate's current requirement (`modelChannelIsolationSql`, shared with `launchIsolatedToModelChannel`): only mail
      released to a launch whose record states the model-only isolation is marked `done` or counts an attempt, and a Run
      whose final launch was not isolated is `gmail_digest_model_unproven` however it ended. Mail an ordinary-egress
      launch received — before the upgrade that added §9 — is never settled done, counts no attempt, stays pending and is
      read again by the next delivery on an isolated launch; a settled delivery is not settled again.
    - *A removed cursor model skips nothing.* When the model a `models_cursor` continued after is itself gone, its old
      place would name a later model; the answer instead lists that configuration's models from the first (with the
      saved one) and says so (`models_restarted`), and the card replaces that configuration's models.
    - *An unsaved switch survives every load.* Whether the owner switched configuration is judged when a page's answer
      is applied — after the first page it may have to add — not when the page answered.

11. **Review amendments (fifth review).**
    - *Isolated or not at all.* A ModelProvider configuration's Run is never launched on ordinary egress. Its contract
      freezes `gmail_digest.model_channel: "required"` (`gmailDigestRunContext` `model_channel_required`), so no later
      change of its profile, Host or Provider binding turns it into an ordinary launch; a Run queued before that is held to
      the same rule while it is provider-bound (`runRequiresModelChannel`). The turn that queues it is refused when its
      binding is not a Provider's or its launch could not be isolated now (`modelChannelLaunchRefusal`: the built-in
      strict Host reporting `model_channel`, a proxy address, the profile's own managed workspace): nothing starts and the
      automation waits with `gmail_digest_model_channel_unavailable` (the owner is told why; no attempt is counted on its
      mail). The launch asks again before any lease, frame or vendor session: no Provider binding or no model-only channel
      now (a daemon that reconnected without it, a paired Host) refuses with `model_channel_unavailable`, as a missing proxy
      address (`provider_proxy_not_reachable`) and a shared workspace (`sensitive_launch_shared_workspace_refused`) already
      did, and settlement names such a Run `gmail_digest_model_channel_unavailable` rather than an unproven model. Before,
      `selectModelChannelLaunch` returning null let it launch with the runtime's ordinary egress (its mail was refused,
      but the conversation's isolated vendor session could be resumed there).
    - *An isolated session is never resumed with network.* A vendor session an isolated launch held
      (`vendorSessionHeldIsolated`: the launch bound to the thread's pointer stated `model_channel`; or, traced through
      the session each launched Run of the thread resumed — `model_override_json.host_thread.runtime_session_id` — an
      isolated Run held it since its origin, the latest launched Run that did not resume it) is resumed only by an
      isolated launch, which judges it as before (`sensitiveThreadResumable`). Any other turn's admission retires it
      before its prompt is rendered (`prepareHostConversationDispatch`; the turn replays fresh), unless the conversation's
      turns launch isolated anyway (a plugin's sensitive read, `conversationCarriesIsolatingReads`); the launch refuses
      a Run admitted otherwise (`isolated_session_resume_refused`) and retires exactly that session, on any thread kind
      (`retireVendorSession`). This covers the owner's ordinary turn in the execution conversation and a later card on a
      runtime-native configuration reusing it; a session an ordinary launch already continued before this check counts as
      held too.
    - *Review flags of an ordinary-egress launch (upgrade).* The earlier code let a provider-bound automation's launch on
      ordinary egress read mail and keep messages for review. Settlement of a delivery still running then puts back to
      `pending` (reason and candidates cleared, no attempt counted) exactly the messages attributable to such a launch
      (`requeueUnisolatedReviewFlags`): `review` now, frozen for this delivery (`last_delivery_id`; a flag needs the
      message frozen for the running delivery and released to the flagging launch), released to a launch of this Run whose
      own attempt record exists and does not state the model-only isolation, and never released to an isolated launch of
      it. The next delivery reads them again on an isolated launch. Everything else keeps its meaning: a flag that could
      have come from an isolated launch, one whose launch record a relaunch of the same attempt replaced (not
      attributable), an earlier delivery's flag, a settled delivery (settlement never reaches it again), `done` and
      `failed` mail, the facts (their ledger and the application they changed; replaying the same fact returns its earlier
      outcome) and every audit and read log. `review` has no other writer: there is no owner-side manual review state to
      lose. Runtime-native automations are untouched (none of their launches is isolated, by design).

12. **Review amendments (sixth review).**
    - *Separate CLI state per channel.* A ModelProvider-bound launch's profile directory names its channel
      (`runtimeProfileKey`: backend segment `<provider>.isolated` for a launch on the model-only channel,
      `<provider>.network` for one with network; `ambient` is never isolated and stays one directory). The two never
      share session transcripts or the CLI's own memory, so nothing an isolated launch was given is on disk for a launch
      with network, whose sandbox binds only its own profile directory. Neither uses the earlier channel-less
      `<provider>` directory both may have written before: it is left as it is (archived and reset with its container,
      as before). A pointer recorded there replays fresh at admission (`pointerInSharedProfile`) instead of failing at
      launch on a session its CLI cannot find; a sensitive turn's admission resumes only a pointer whose isolated launch
      recorded an `.isolated` directory (`sensitiveThreadResumable` without a profile key), and its launch still the exact
      profile.
    - *A networked resume on the record only.* A launch with network resumes the session frozen on its Run only when
      the thread is open, the session is not retired, no isolated launch held it (`vendorSessionHeldIsolated`), and it is
      either the thread's current pointer or the Run's own parked session as the launch that reported it records it
      (that launch's record states no model channel and no launch of the Run was isolated; as amended by §13, the
      Run's own copy of that record, in this launch's directory) — `networkedResumeVerdict`. Before, a session an isolated launch
      started fresh (it resumed none) stopped counting as held once the pointer was cleared or replaced, so a Run admitted
      before that, or the retry of a Run whose resume was refused, could resume it with network. Now such a Run fails
      before any frame (`resume_session_unconfirmed`, or `isolated_session_resume_refused` when held) and only that session
      is excluded (`excludeVendorSession`: retired with the pointer if the pointer still names it, otherwise only listed
      as retired); a session parked before its launch was recorded with it is refused likewise (§13: a relaunch of the
      same attempt no longer is). A resume with no thread is refused; only a protocol test with no database is not judged.
    - *Review flags judged per read log.* `requeueUnisolatedReviewFlags` puts a flag back to `pending` only when every
      read log of the Run naming the message is determinably an ordinary launch's — its nonce still on an attempt of the
      Run whose record states that launch and no model channel — and at least one is the digest read's. A log naming an
      isolated launch, no launch, or a nonce no attempt carries now (a restart of the same attempt rewrote the record) keeps
      the flag, as before for an isolated release; one ordinary release no longer outweighs an unknown one.

13. **Review amendments (seventh review).**
    - *One snapshot.* `networkedResumeVerdict` reads the thread's state (open, retired sessions), its pointer and that
      pointer's launch record, the isolation history (`vendorSessionHeldIsolated`, now one SQL expression shared by both)
      and the Run's own parked record in one statement, so no reset, report or retirement can fall between two reads of
      different snapshots.
    - *The directory is part of the proof.* A launch with network resumes a session only when its record names this
      launch's own CLI directory (`profile_key`): the pointer's bound launch, or the Run's parked record. A Run queued
      before the channel split — and a Task Run, which no conversation admission judged — that still names a session in
      the channel-less `<provider>` directory, or another backend's, fails before any frame (`resume_session_unconfirmed`)
      and that session is excluded, instead of handing the CLI a session its directory does not hold. Only the `ambient`
      directory, whose key never changed, keeps a pointer with no directory on record (imported CLI history, earlier
      launch records); a ModelProvider directory needs the record.
    - *Ownership survives a relaunch of the same attempt.* A relaunch (`bindAttemptLaunch` with the previous nonce)
      rewrites the attempt's nonce and record, so a nonce alone stopped proving the parked session's origin: a parked
      Run whose resume launch failed before parking again was refused on its retry and its session excluded for good.
      Now parking copies the reporting launch's own record (`runtime_session_launch`: its `launch_isolation_json` and
      attempt id) onto the Run, matched by the nonce the adapter reports (`metadata_json.launch_id`) while the attempt
      still carries it; the verdict judges that copy (no model channel, this directory) plus every current attempt
      record of the Run (none may state a model channel). With no reported nonce, one no attempt carries any more, or a
      park recorded before this copy existed, the record is unknown (null) and the resume is refused.
    - *Resets and archives.* Unchanged rules, now covered: a reset retires the pointer (a parked Run whose session it
      named is refused), a parked session the reset did not name keeps its own record, and an archived (closed) thread
      refuses every resume.

14. **Review amendments (eighth review).**
    - *Judged and bound under the thread's lock.* The launch's resume check (`networkedResumeVerdict`, or
      `sensitiveThreadResumable` for an isolated launch) is judged once before anything is prepared and again in the
      transaction that binds the launch nonce (`PgRunRepository.bindAttemptLaunchAfterResumeCheck`, from
      `bindHostAttemptLaunch`), after share-locking the thread row: the last step before the frame leaves, after the
      wait for the attempt's previous launch to exit. A reset, retirement or archive that committed before that lock is
      seen, nothing is bound and no frame leaves (`resume_session_unconfirmed`, `isolated_session_resume_refused` or
      `sensitive_resume_unconfirmed`, and only that session is excluded, as at the early check). Before, a reset
      committed between the early check and the bind — while the previous launch was being stopped, say — let the frame
      hand the CLI the retired session. *A bind that commits first* has authorized the launch: a reset that comes later
      waits for that commit, then applies to it as to any launch already in flight — the frame still leaves, the
      session it resumes is retired, so its report never becomes the pointer again (`recordRunOutcome`), a park of it is
      never resumed, and an archive closes the thread for every later resume. Lock order is the `host_threads` row, then
      the Run's `run_attempts` row; no transaction takes them the other way round, and no Host is awaited under the lock.
    - *Ambient only for native history never bound to a directory.* §13 let a pointer whose launch recorded no
      directory resume in `ambient`. That covered too much: a bound pointer whose record is gone (a relaunch replaced its
      nonce) or names no directory, and history from a ModelProvider launch recorded before records named one. Now only
      a pointer no launch was ever bound to (`vendor_session_launch_id` null: imported CLI history, a pointer from before
      bindings) resumes in `ambient`, and only on a thread none of whose launched Runs was ModelProvider-bound
      (`runs.model_provider_id`), stated a model channel or recorded a directory other than `ambient`. Everything else
      needs a record naming the launch's own directory, as before.
    - *A Host reset retires parked sessions too.* `host-state/reset` archives every profile the Agent has on the Host,
      but retired only the threads' pointers: a Task Run waiting for review (a status the reset admits) whose launch had
      parked it in a session no pointer names still resumed it from its own record, into a profile that no longer holds
      it. `retireAgentSessionsOnHost` now also lists as retired, on its thread, the session each Run of that Agent on
      that Host that may still launch (not hard terminal) froze or parked in (`host_thread.runtime_session_id`), so its
      resume is refused before any frame. Another Agent's or another Host's parked session, and a session a person's
      conversation reset did not name, keep their own record and resume as before.

15. **Review amendments (ninth review).**
    - *A reset fences launches by generation, not by what it saw.* §14 retired, at admission, the sessions the reset
      could see. But the reset admits a Run waiting for review, and the orchestrator parks such a Run only once its
      adapter returns: a launch still reporting when the reset commits parked it afterwards in a session the reset never
      saw, in a profile the Host was archiving, and that park resumed from its own record once the fence lifted. Now
      every launch record carries the reset generation of its Agent on that Host (`host_reset_generation`: how many
      `agent_host_state_reset` intents for that Host and Agent were ever admitted, read in the statement that binds the
      nonce, `bindAttemptLaunch`; `hosts/agentHostResetGeneration.ts`). A record whose generation is behind the
      current count is a launch from before a later reset: `networkedResumeVerdict` refuses its pointer and its parked
      copy, `sensitiveThreadResumable` its pointer, whenever the report arrived. A late park
      (`recordParkedHostThreadSession`) or late outcome (`recordRunOutcome`) of such a launch also lists the session
      as retired on its thread (only the thread row is written; the Run row is read). A record bound before
      generations existed is judged on time: stale when a reset was admitted at or after its attempt started. A launch
      bound after the reset carries the new count and parks and resumes as before; a reset of another Agent, or on
      another Host, changes nothing.
    - *Admission covers every thread the reset retires on.* §14's parked retirement reaches a Location thread whose
      latest Run is another Agent's, where a Run of this Agent that may still launch is parked; admission locked and
      checked only threads whose latest Run was this Agent's. It now locks those threads too and refuses while this
      Agent's Run on them is in flight (another Agent's Run there does not block this Agent's reset), and the reset
      counts each thread it retired something on once.
    - *Native history includes Runs from before launch nonces.* §14 judged a thread's history only on attempts with a
      launch nonce, so a ModelProvider-bound Run from before nonces did not count against an unbound pointer. Now every
      Run of the thread that started counts — ModelProvider-bound on the Run or on its frozen profile
      (`backend_mode = 'model_provider'`), any attempt stating a model channel, or any recorded directory other than this
      launch's own (`profile_key`, exact, not only the `/ambient` suffix). An isolated resume is also refused on an
      archived (closed) thread.
    - *A refused resume is terminal.* A Run whose launch refused its frozen session (`resume_session_unconfirmed`,
      `isolated_session_resume_refused`, `sensitive_resume_unconfirmed`) carries the same session on every attempt, so
      the Supervisor no longer holds it for a review whose resume would only repeat the refusal; it stays failed and a
      new turn or Task Run starts a fresh session. Any other failure of the same kind is still held for review.

16. **Review amendments (tenth review).**
    - *A park is serialized with the reset.* §15 fenced a late park by its launch's generation, read in the park's own
      statement. A park that committed after the reset's scan of parked sessions but before the reset's intent
      committed saw neither: the scan had missed it and the generation was not yet counted, so it stayed unretired (its
      frozen record still refused the resume once the reset committed, but ambient import could take it for the owner's
      history). `recordParkedHostThreadSession` now writes the park and judges its retirement in one transaction that
      first takes, shared, the advisory lock the reset admission holds exclusively from before its scan until its intent
      commits (`agentHostResetLockKey`: `agent-host-reset:<host>:<agent>`, the one key the launch fence also takes), for
      the thread's Host and the reporting launch's recorded Host, in key order. A park therefore commits wholly before
      the scan, which retires it, or runs wholly after the intent is visible, and its generation retires it. Locks: the
      advisory lock before any row, then the Run row, then the thread row — the order thread settlement takes them. A
      park with no trusted record (no nonce, or one no attempt carries) is retired when a reset of the Agent on the
      thread's Host was admitted at or after the Run was created. Ambient import also excludes every session a Run of a
      matching thread froze or parked in (`listVendorSessionIds`), whatever its retirement.
    - *Time evidence is the attempt's creation.* §15 judged a record bound before generations on
      `COALESCE(started_at, created_at)` of its attempt. A claim of the same attempt after an approval rewrites
      `started_at` to the re-claim's time, so a pre-reset launch re-claimed after the reset looked newer than it. It is
      now judged on `run_attempts.created_at`, written once and never later than any launch of the attempt: a reset at
      or after it makes the record stale; an attempt that cannot be found gives no evidence and any reset makes it stale.
      This is conservative: a legacy launch whose attempt was created before a reset but launched after it fails once
      and continues in a new session.
    - *Shared threads are locked in id order.* Two Agents' resets on one Host take different advisory locks and may
      both cover one Location thread (§15). The admission now locks its threads `ORDER BY thread.id`, as do the other
      multi-row thread locks (`closeDirectConversationThreads`, `deleteSession`'s direct threads). The rest of the order
      is unchanged: `host_threads` before the Run's `run_attempts` in the bind (§14); `runs` before `host_threads` in
      settlement and the park; the reset takes its Host and Agent rows shared, then its advisory lock, then its threads.

## Consequences

- §9 amends ADR 0033 §6 (an application automation's provider-bound Run launches on the model-only channel) and ADR
  0034 §3 (its launch-bound model also needs that isolated launch); the runtime-native path is unchanged.
- §10 tightens §9 only (what is offered, admitted at the turn and settled); it relaxes nothing, and the runtime-native
  path is unchanged.
- §11 tightens §9 and §10: a provider-bound automation fails before launch instead of falling back to ordinary egress,
  no launch with network resumes a session an isolated launch held (for every conversation, not only Gmail's), and an
  ordinary-egress launch's attributable review flags are retried. A runtime-native automation and a Gmail read in an
  ordinary conversation keep their rules; an ADR 0030 sensitive plugin pin keeps its own (an ordinary launch there
  still reads nothing sensitive).
- §12 tightens §11 only: separate directories per channel, networked resumes judged on the record, flags kept when any
  read log's launch is unknown; it relaxes nothing. A provider-bound conversation's pointer in the earlier shared
  directory replays fresh once after the upgrade, and a Run parked before it whose session the pointer does not name
  fails once (`resume_session_unconfirmed`) and continues in a new session.
- §13 tightens §12 (one snapshot; the directory proven) and repairs a regression it introduced (a parked Run's
  same-attempt relaunch keeps its session). A Run queued before the split whose session is in the shared directory
  fails once at launch instead of failing in the CLI; a Conversation switched between a ModelProvider and the
  machine's login starts a fresh session (as documented for `runtimeProfileKey`), now refused before the frame.
- §14 tightens §13 only (the check serialized with the bind, the ambient fallback narrowed, parked sessions retired
  by a Host reset); a launch it now refuses fails before any frame and the next turn starts a fresh session. Tested on
  real PostgreSQL (`sensitiveRuntimeProfileDb.test.ts`, `gmailApplicationUpdatesDb.test.ts` `ADR 0036 §14`); the new
  cases fail with the lock, the bind-time guard or the parked retirement removed.
- §15 tightens §14 only (a reset generation on every launch record, admission over every thread the reset retires on,
  pre-nonce history counted, refused resumes terminal). A launch recorded before generations existed is judged on time;
  a Run parked before the upgrade whose launch predates a reset fails once and continues in a new session. Tested on
  real PostgreSQL (`agentHostStateResetDb.test.ts`, `sensitiveRuntimeProfileDb.test.ts`, `runSupervisorDb.test.ts`,
  `gmailApplicationUpdatesDb.test.ts` `ADR 0036 §15`); the adapter case fails with the generation check removed.
- §16 tightens §15 only (the park serialized with the reset, creation time as the legacy evidence, shared threads
  locked in id order, Run-parked sessions never imported). Tested on real PostgreSQL (`agentHostStateResetDb.test.ts`
  `ADR 0036 §16`); each case fails with its fix removed.
- Amends ADR 0034 §3 (the card freezes the owner's choice, not the asking conversation's binding; drafting no
  longer refuses an unprovable, alias or default model of that conversation) and §2 (a private card runs in the
  owner's private execution conversation, not the one it was asked in), and ADR 0035 §1 (the execution
  conversation now serves every card). Every other rule of ADR 0030, 0033, 0034 and 0035 stands.
- Code: `server/src/modules/sources/gmail/gmailApplicationExecution.ts`, `gmailApplicationUpdates.ts`
  (drafting, card text), `gmailApplicationUpdateRuns.ts` (`providerPinnedModel`, `applicationBindingKey`),
  `gmailDigests.ts` (acceptance), `gmailSetupProposal.ts` (`gmailSetupSummary`, part lines, reuse),
  `gmailApplicationSharedConversation.ts`, `agents/projectChatActionPreviews.ts`,
  `systemActions/operations/runtime.ts`, `runs/remoteProviderBinding.ts` (`providerLeaseTarget`),
  `runs/modelChannelLaunch.ts` (`selectModelChannelLaunch`, `runSelectsModelChannel`, `hostServesModelChannel`,
  `modelChannelLaunchRefusal`, `launchIsolatedToModelChannel`, `modelChannelIsolationSql`, `runRequiresModelChannel`),
  `runs/hostProviderProxyAddress.ts`, `runs/remoteHostCliAdapter.ts` (the launch's refusals),
  `runs/sensitiveRuntimeProfile.ts` (`vendorSessionHeldIsolated`, `conversationCarriesIsolatingReads`,
  `networkedResumeVerdict`, `pointerInSharedProfile`), `runs/remoteProviderBinding.ts` (`runtimeProfileKey`),
  `runs/repository.ts` (`recordParkedHostThreadSession`), `runs/orchestrationService.ts` (the parked nonce),
  `agentGroups/service.ts` (`prepareHostConversationDispatch`), `hosts/threadRepository.ts` (`retireVendorSession`,
  `excludeVendorSession`),
  `agents/chatOperations.ts` (`queuePrivateProjectTurn`), `gmailDigests.ts` (`requeueUnisolatedReviewFlags`);
  protocol `gmail.ts` (candidate, selection, options schemas, `models_of`/`models_cursor`; null binding
  allowed on an application card), `systemActions.ts`; web `api/gmail.ts`,
  `modules/sources/gmail/GmailApplicationExecutionChoice.tsx`, `modules/conversation/ActionPreviewCard.tsx`, i18n.
- Tests: `server/test/gmailApplicationUpdatesDb.test.ts` (`ADR 0036` cases: card opened from an unprovable
  conversation, candidate reasons, owner-only listing and choice, an unavailable choice refused, offline Host
  refused at acceptance, frozen execution conversation, Assistant default; the combined card redrawn and accepted
  on the choice; the earlier ADR 0034 cases rewritten to the new contract), web
  `gmailApplicationExecutionCard.test.tsx`, Chromium `conversation-layout.browser.mjs` (Room card in both themes and
  locales at 390 and 1280 px).
- Review tests (`ADR 0036 review` cases): the Assistant confirmed, started and read for end to end; another Project's
  Assistant refused at the start; an Agent removed from the Project refused at the start and at the read; acceptance
  bound to the shown revision (stale, missing, replayed choice after losing Project access); the frozen rule version
  (overwrite, revival, unversioned cards); a long Agent list. Web: Accept blocked while saving, reload on a changed
  revision, the omitted count.
- Second review tests: two first cards with the first accepted and ended; `chosen_on_card` on the Proposal detail,
  list and home summary; 225 available rows before the Assistant, paged to the last Agent's last model, chosen and
  accepted; a private daily digest after its Agent left the list (`gmailMonitorSyncDb.test.ts`); the Assistant run as the
  scheduler queued it and the dispatcher's own routing (`routeRun`) resolved it — only the Host side (echoed option,
  launch binding, model proof) is synthetic. Web: paging, the direct chat, the Proposal detail and list.
- Two-level tests (§8): `two levels` (a configuration's reason once, a model's under its configuration, both levels
  echoed by acceptance's check, racing choices) and `a non-Claude configuration` (Codex CLI on a ModelProvider chosen,
  accepted, scheduled, routed, leased and read; unbound, echoed, other and earlier-launch requests refused) in
  `gmailApplicationUpdatesDb.test.ts`; `acpModelProof.test.ts`; web card and Chromium cases for switching and echo.
- Third review tests (§9): `a non-Claude configuration admitted through the public paths` (OpenCode Provider Profile
  through `provider.create` and `agent.runtime_profile.create`; Codex CLI refused by admission and listed
  `provider_unsupported`; `provider_endpoint_missing`, `provider_unavailable`, `model_channel_unavailable`; chosen,
  accepted, scheduled, routed, selected for the model-only channel, admitted by `sensitiveLaunchRefusal`, leased with the
  channel and read only on the isolated launch — not on an ordinary-egress launch with the right model), the
  provider-bound release gate with each missing isolation fact, and `ADR 0036 §9: past 200 models` (206 models, the saved
  206th listed first, a keyed cursor surviving a removal, a second-page model chosen and accepted). Web: Accept disabled
  while a page loads, an unsaved switch kept against a page of another revision, the first page added for an unlisted
  saved choice, more models, an unlisted saved model never echoed; Chromium Room card with `model_channel_unavailable`
  and "Show more models".
- Fourth review tests (§10): in `gmailApplicationUpdatesDb.test.ts`, the §9 public-path case also refuses a missing
  proxy address and a Workspace Location profile on the card (and that profile's launch through `sensitiveLaunchRefusal`);
  `ADR 0036 §9: past 200 models` restarts the list when the cursor's model is removed; `ADR 0036 §9 upgrade` (a delivery
  whose mail an ordinary-egress launch received is not delivered, counts no attempt, is not settled twice, and its mail
  is read again and settled on an isolated launch after the admission reset the earlier vendor session; a failed one
  counts no attempt). Web: a switch made while the first page is added is kept; restarted models replace the list.
  Chromium: the Room card lists a `model_channel_workspace_shared` configuration.
- Fifth review tests (§11): in `gmailApplicationUpdatesDb.test.ts`, `ADR 0036 §11` (Host capability, proxy address and
  Workspace Location degraded after acceptance start nothing with `gmail_digest_model_channel_unavailable`; through the
  Host adapter itself, a capability lost or a Provider binding gone after queueing refuses before any frame, lease or
  read, and settlement names it), the ordinary launch refused before the frame from resuming the automation's isolated
  session, and `ADR 0036 §11 upgrade` (an ordinary-egress launch's flag back to pending; a flag also released to an
  isolated launch, an earlier settled delivery's flag, the fact and audits kept; idempotent); in
  `sensitiveRuntimeProfileDb.test.ts`, an ordinary turn's admission retiring an isolated session (also one an ordinary
  launch already continued, and on a direct thread) while a conversation with a plugin's sensitive read keeps it. Web:
  the automation's new waiting reason. Each new case fails with its fix disabled.
- Sixth review tests (§12): in `sensitiveRuntimeProfileDb.test.ts`, the channel-split keys, a shared-directory pointer
  replayed fresh while a `.network` one resumes and a sensitive admission resumes only `.isolated`, an isolated
  session created fresh refused after its pointer was cleared or replaced and on a retry (and on a closed or missing
  thread), and a parked session resumed only on its reporting launch's record (refused for another Run, a rewritten
  record, an unrecorded launch, an isolated launch); in `gmailApplicationUpdatesDb.test.ts`, the retry of the refused Run
  through the Host adapter (`resume_session_unconfirmed`, no frame), two flags kept for a read log of a rewritten or
  missing launch, and the concurrent choices asserting content revisions (each answer's revision is its own content's;
  re-choosing the shown model restores the shown revision); `pluginDataAccessDb.test.ts`, a real dispatch's frames in
  `.isolated` and `.network` directories. Each new case fails with its fix disabled.
- Seventh review tests (§13): in `sensitiveRuntimeProfileDb.test.ts`, a parked session resumed across two relaunches
  of the same attempt and after parking again (refused in another directory, for another Run, and once a launch of the
  Run states the model channel), refused without a trusted record (a legacy park, a nonce already replaced, no nonce,
  an isolated launch's), a pointer resumed only in its recorded directory (a pre-split pointer and a `.network` one
  in `ambient` refused; an unprofiled or imported pointer only in `ambient`), reset and archive, and the verdict as
  one statement; in `gmailApplicationUpdatesDb.test.ts`, through the Host adapter, a parked Run's relaunched attempt
  reaching its launch frame with nothing excluded and a pre-split pointer refused before any frame. Each fails with
  its fix disabled (directory identity ignored; parked ownership by the attempt's current nonce).
- Ninth review tests (§15): in `agentHostStateResetDb.test.ts`, through the real reset route, a Location thread whose
  latest Run is another Agent's locked and checked (refused while this Agent's Run there is queued, admitted while it
  waits for review, one thread counted), a park reported after the reset retired and refused on its record alone, the
  other Agent's park kept, a launch bound after the reset parking and resuming until a second reset, and a late outcome
  of an earlier launch retired instead of becoming the pointer; in `sensitiveRuntimeProfileDb.test.ts`, a started
  pre-nonce ModelProvider Run and another `ambient` directory counted against native history, an isolated pointer
  refused after this Agent's reset (not another Agent's) and on an archived thread; in `runSupervisorDb.test.ts`, the
  three refusals left failed while another failure is held for review; in `gmailApplicationUpdatesDb.test.ts`, through
  the Host adapter, a late park refused before any frame with nothing bound and a post-reset park reaching its frame.
- Tenth review tests (§16): in `agentHostStateResetDb.test.ts`, through the real reset route and the production park,
  claim and import-exclusion entries, a park arriving after the reset's scan and before its commit (it waits on the
  fence, is retired, is refused and is excluded from ambient import even with its retirement dropped), a park with no
  trusted record after a reset retired, a legacy record re-claimed after an approval (same attempt, `started_at` after
  the reset) still refused for its park and its late outcome, and a reset holding the lower of two shared threads while
  it waits on the higher (a concurrent pair of two Agents' resets both admitted). Not exercised concurrently: a park that
  takes the fence first, so the reset waits for it; once it commits that is the sequential §14 case (the scan retires it).
- Not covered: live runtimes (Claude Code, Codex CLI, OpenCode), a live strict Host daemon and its model-only channel,
  a live ModelProvider upstream, a live Google project or mailbox; whether a live Host's picker lists full model ids;
  the card's own summary text is English (as every Gmail card's server text), while the scope and choice are
  translated.
