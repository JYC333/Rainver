# ADR 0032 — On-demand Agent reads of the owner's Gmail

Date: 2026-11-18
Status: accepted and implemented on the workspace branch, partly superseded by
[ADR 0033](0033-gmail-project-consent-and-private-delivery.md). Nothing was
deployed, no Google project was configured and no real mailbox was read.
ADR 0033 replaces this record's per-Run consent with the owner's standing
consent per Project, mailbox and purpose (§1–4), and replaces where the tool
is offered and how it runs (§6): reads happen in place in every ordinary
conversation of a Project — the owner's private conversation, a Room or the
mainline — on that conversation's own runtime, never on an isolated launch.
Daily and rule digests are ADR 0033's phase B. What stands here: the core
registry, the tool and its request bounds, the release gate, taint and
event-log exclusion, and the per-Session host-state and launch rules, which
now serve sensitive plugin data (ADR 0030).

## Context

The Gmail connection and new-mail monitors
([Sources](../modules/sources.md#personal-gmail-connections-connection-lifecycle-new-mail-monitors-legacy-project-selections)) let
the owner read selected threads and get content-free reminders; no Agent read
mail. The owner now wants an Agent to read their recent mail, or a search, and
summarize it in the same private conversation.
[ADR 0030](0030-plugin-agent-data-access.md) already defines how an Agent reaches
sensitive data — data-owner consent per Run, an owner-only manual scenario, a
network-isolated launch with a model-only channel, a release gate, merge-only
taint with an outward-write refusal, and owner-only attribution — but only for
plugin operations. Gmail is a core Sources module.

## Decision

1. **Core sensitive tools take ADR 0030's path.** A small core registry
   (`server/src/modules/plugins/coreDataTools.ts`) declares a core Agent tool's
   pin (`data_class: sensitive`, read-only, no gate) and a reserved consent id
   that no plugin id can take (`core:gmail`). `pluginToolMeta` returns it, so
   the snapshot pin, scenario table, `plugin_data_grants` consent, the
   authorization-request flow with the data owner as the only approver, the
   release gate, taint, egress refusal and attribution all apply as for a
   sensitive plugin read. Gmail's tools are Project-bound (`projectBound`):
   they need no isolation proof and keep the conversation's runtime, and
   their only consent is the owner's standing, read-only `project` consent
   (ADR 0033 §1, §6); no per-Run, `background` or Space-wide consent exists
   for them, and ADR 0033's digest purposes use the same `project` consent
   under `core:gmail_digest`.
2. **One tool, `source.gmail.mail.read`.** Newest inbox messages (no query) or
   a Gmail search (the owner's words plus fixed exclusions of drafts, chats,
   spam and trash); at most five messages per call, plain text, 32 KiB per
   message, ten released reads per Run. It is an operation-core query; its
   release gate writes the taint, the Agent-read log and an `agent_read` row
   in the owner's Gmail read audit before the result leaves. Its own request
   allowlist admits only `messages.list` and `messages.get format=full`.
3. **Where it is offered** is ADR 0033 §6: the mailbox owner's own `manual`
   turn in an ordinary conversation of a Project, after the owner opted in on
   an active connection (`gmail_connections.agent_read_enabled`, off by
   default, cleared by disconnect), and only to an audience whose every reader
   reads that Project. Outside a Project conversation, without the opt-in or
   outside that turn the tool is absent from the snapshot; an audience outside
   the Project is refused at call time and at release
   (`gmail_agent_read_audience_outside_project`).
4. **The call stays out of logs.** The tool call's arguments and result never
   enter the Run's event logs, and nothing stores the result server-side; the
   reply belongs to the conversation and its audience (ADR 0033 §6). A Run of
   the owner's private conversation that pins a Gmail tool, and every later
   Run of a conversation holding sensitive plugin data
   (`sensitive_conversation`), is owner-only content for every oversight
   mode; the latter also launches isolated or fails
   (`sensitive_conversation_isolation_required`). A Room or mainline Gmail Run
   keeps its conversation's audience.
5. **The conversation carries the read forward.** A Run that read mail
   materializes no artifacts, proposals or activities, and the conversation is
   not reflected into a Memory proposal. Every later Run of the conversation
   inherits the read's taint (outward writes refused, Memory writes refused)
   on its own runtime, decided separately from `sensitive_conversation`, which
   only sensitive plugin data sets (ADR 0033 §6).

## Consequences

- **Gmail reads keep the conversation's runtime.** A paired Host, a CLI on
  its own vendor login or a ModelProvider binding reads through the server's
  Gmail broker; the credential never leaves the server and the runtime
  receives only the bounded result (ADR 0033 §6). A Run is never selected for
  the model-only channel because it may read Gmail; the isolated launch of
  ADR 0030 §4a stays for sensitive plugin data.
- **Host state per Session, decided at admission.** A non-Project direct chat
  otherwise uses the owner's direct container (`host_threads` keyed by Agent ×
  owner): one vendor session pointer, one managed cwd and one CLI profile
  (`agents/<agent>/direct/<owner>/…`) shared by all their direct chats with
  that Agent. When a turn is admitted — before its Run exists and before
  Runtime Context is assembled — a chat that may read (a core data tool
  offered there now, or an earlier Run of the Session pinned a sensitive tool)
  is placed in its Session's own Conversation container instead: its own
  thread, managed cwd (`conversations/<session_id>`) and profile
  (`agents/<agent>/conversation/<session_id>/…`), the mechanism a Project
  direct chat already uses (`agents/chatOperations.ts`,
  `runs/sensitiveRuntimeProfile.ts`). Whether the turn is fresh is that
  thread's ordinary rule, so a first turn — or one after a first launch that
  failed before the runtime started a session — replays as fresh. The
  thread's current vendor session pointer is bound to the launch that
  reported it (`host_threads.vendor_session_launch_id`, set with the pointer
  and cleared with it by every reset, close or rotation, migration 0030). It
  is resumed only if that launch, a launch of this thread, was isolated
  (strict Host, egress `none`, model channel); otherwise it is retired at
  admission, judged on the thread as re-read under the turn's dispatch claim.
  Each launch record names its CLI `profile_key`, and a resume is refused
  before launch (`sensitive_resume_unconfirmed`) unless the session id the
  frame hands the CLI is still exactly the thread's current pointer and its
  bound launch was isolated in exactly the current profile. Only that handed
  session is retired by the refusal: a newer pointer recorded since (the
  Run's snapshot predates it) is kept for the next turn to judge, and a
  resume with no thread is refused outright. Older launches of the thread do not
  count: after a reset, a session a later isolated launch started resumes
  although unisolated history remains. A failed turn that reports no session
  keeps pointer and binding; a late report of a retired session changes
  neither; a pointer with no binding (from before migration 0030, or reported
  by a Run with no recorded launch) is never resumed here.
- **Launch re-check.** Because the snapshot is frozen after admission, a Run
  that must launch isolated (it continues a sensitive conversation; Gmail's
  Project-bound pins do not count) or was selected for the isolated launch is
  refused before launch unless its profile
  is its own Session's Conversation profile (`sensitive_profile_session_unconfirmed`),
  its managed cwd is its own Session's and it mounts nothing shared writable —
  no writable Location, isolated Location worktree or writable attachment
  (`sensitive_launch_shared_workspace_refused`; read-only mounts stay
  possible). The same applies to ADR 0030 sensitive plugin Runs of a
  conversation.
- **Not covered here:** what earlier Runs left in the owner's shared direct
  container is not moved or cleaned; an Agent-scoped Run with no Session
  (ADR 0030 background plugin reads) keeps its Agent profile; the first turn
  of a chat moved to its own container starts a fresh vendor session and cwd
  (its transcript is replayed, not the earlier vendor session or files); a
  retry of a turn admitted in the other container is refused for review; a
  managed-workspace restore is not offered in such a chat (its context reset,
  `agent.chat.reset_context` with the `session_id`, resets the Session's own
  thread, the one its turns use, only for the Session's owner); the Session's
  container is not archived or removed on the Host when the direct chat is
  deleted.
