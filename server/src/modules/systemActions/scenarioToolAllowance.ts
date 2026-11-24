import {PROJECT_NOTE_AGENT_ACTIONS} from '@rainver/protocol';
import type { PluginOperationId, SystemActionId } from "@rainver/protocol";

/** A scenario allowance entry: a core action, or a plugin operation named one by one. */
export type ScenarioToolId = SystemActionId | PluginOperationId;

/**
 * Scenario tool allowances.
 *
 * `buildRunToolGrants` intersects what a Run declares with what it is
 * *allowed*, and fails closed when the allowance is missing. The allowance
 * comes from two places. The immutable AgentVersion's
 * `tool_permissions_json` models a tool as a property of the Agent —
 * "this Agent is permitted to do X" — which is right for an Agent's own
 * standing skills, and wrong for a capability that belongs to a *place*.
 *
 * Advancing a Project by talking about it is a property of the Room, not of
 * whichever Agent happens to be in its roster: a Room's roster is fixed at
 * creation, so binding these actions to Agents means picking a differently
 * configured Agent silently produces a Room where conversation does nothing,
 * with no surface anywhere that explains why (there is no UI for
 * `tool_permissions_json` at all). A scenario allowance is the same
 * fail-closed white list applied at the right scope.
 *
 * This does not widen `buildRunToolGrants`: an action outside the list is
 * still denied, and the Run must still declare it.
 */

/**
 * What an Agent may do because it was spoken to in a Room.
 *
 * The Inquiry entries are not uniform: `inquiry.create_thread` and
 * `inquiry.record_conclusion` write directly, bounded and origin-gated, while
 * `inquiry.promote_knowledge` stays a proposal because it leaves the Project
 * (ADR 0017 §1/§2). `agent.delegate` and
 * `research.start_acquisition` are both visible, directly-executed
 * coordination actions — `agent.delegate` is independently constrained by
 * the Room's one-level, shared soft/hard delegation budget, and
 * `research.start_acquisition` is idempotency-guarded rather than
 * proposal-gated: the Thread was already human-accepted at creation.
 * `research.cancel_acquisition` is its stop lever, listed here so a Room
 * notification about running research always has a matching in-Room action.
 * Do not leave a report the user can only act on by leaving for the web UI.
 * The two are not mutually exclusive —
 * an ad hoc delegated investigation and a tracked acquisition Workflow may
 * run on the same Thread at once; choosing between (or combining) them is
 * the Manager Agent's judgment, never a server-side gate.
 *
 * **Retrieval is deliberately absent, and adding it is not a one-line
 * change.** The same list is written to the Run's `capabilities_json`, and
 * `explicitRetrievalToolDomainsFromRun` (`runs/managedRetrievalTools.ts`)
 * treats a retrieval action id appearing there as the *enablement switch* for
 * that retrieval domain — listing it does not merely permit a tool, it turns
 * the domain on. Retrieval then executes under `instructed_by_user_id`, the
 * message sender, whose read access includes their own `private` content,
 * while the Run's reply is visible to every Room member. So granting
 * retrieval here would let one member's private notes, sources, or Project
 * summaries be surfaced into a shared conversation by asking a question.
 * Grounding a drafted conclusion in Project material is genuinely wanted, but
 * it needs a retrieval path scoped to what the whole Room may read, not the
 * speaker — that is a separate piece of work, not an entry in this array.
 */
/**
 * What an Agent may do in *any* conversation with a person, Room or not.
 *
 * Remembering what they told you is a capability of talking with someone, not
 * of the Room: it writes nothing anyone else reads — the entry is private to
 * the speaker, about the speaker, and carries no Project — so none of the
 * reasoning that binds the Project writes below to a Room applies to it. An
 * Agent that only learns when the conversation happens to be in a Room is the
 * gap ADR 0003 §2 set out to close, not a smaller version of it.
 */
export const CONVERSATION_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  "memory.remember",
  "memory.revise",
  // The conversation's own record. The vendor session is the Agent's working
  // memory and Rainver keeps every message and Agent event; after a summary
  // or a renewed session, what the summary left out is looked up here rather
  // than replayed into the prompt.
  "conversation.search",
  "conversation.read",
  // Drafting a private Gmail monitor is, like a memory about the speaker, a
  // property of talking with the mailbox owner, not of a Project. It writes
  // only a proposal the owner decides and reads no mail; the executor refuses
  // it unless this is the owner's own turn with an owner-only audience.
  "source.gmail.monitor.propose",
  // Drafting the owner's scheduled Gmail digest (ADR 0033 phase B): a proposal only the owner
  // accepts, only in their own turn of a conversation of a Project (private, a Room or the mainline,
  // every reader inside the Project) that it then delivers into; it reads no mail.
  "source.gmail.digest.propose",
  // The owner's automatic application updates from Gmail (ADR 0034): drafting the one owner-only card,
  // listing (content-free) and pausing or ending it. Each executor admits only the mailbox owner's own
  // turn in a conversation of a Project that only they read; none reads mail.
  "source.gmail.application_updates.propose",
  "source.gmail.application_updates.list",
  "source.gmail.application_updates.set_status",
  // On-demand reading and searching of the owner's own mail (ADR 0032, ADR 0033 §6). Listing it here only
  // makes it a candidate: the snapshot admits it in an ordinary conversation of a Project after the owner's
  // opt-in, on the conversation's own runtime; every read needs the owner's own turn, their standing
  // consent for that Project (confirmed once in place) and an audience inside that Project.
  "source.gmail.mail.read",
  // ADR 0035: one owner-only card for several Gmail purposes, and the owner's read delegations to Project
  // members (drafting, listing, ending). Each executor admits only the mailbox owner's own turn in a
  // conversation of the Project whose readers all work in it; none reads mail.
  "source.gmail.setup.propose",
  "source.gmail.delegation.propose",
  "source.gmail.delegation.list",
  "source.gmail.delegation.end",
  // A member's read of mail delegated to them (ADR 0035 §4): offered only where such a delegation exists for
  // the conversation's Project; every read is confined to the owner's scope and rechecked at release.
  "source.gmail.delegated.read",
];

/** Added only for a turn whose persisted message owns text resources. */
export const INPUT_RESOURCE_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  "input_resource.read",
  "input_resource.search",
];

const ROOM_PROJECT_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  ...PROJECT_NOTE_AGENT_ACTIONS,
  "project.propose_definition",
  "inquiry.list_threads",
  "inquiry.read_problem",
  "inquiry.create_thread",
  "inquiry.record_conclusion",
  "inquiry.record_work",
  "inquiry.link_task",
  "inquiry.list_tasks",
  "inquiry.reference_task_result",
  "inquiry.close_round",
  "inquiry.promote_knowledge",
  // Both halves of delegation: a Manager that can hand work out but never
  // collect it can only say "I've asked" and end the turn.
  "agent.delegate",
  "agent.wait_for_results",
  "agent.list_runs",
  "agent.cancel_run",
  // The Project write surface. Without these an Agent can describe a
  // decomposition in a reply but not create it, which is the gap between
  // sounding like it advanced the work and having advanced it.
  "task.list",
  "task.create",
  "task.create_batch",
  "task.report",
  "task.handoff",
  "task.update",
  "task.set_status",
  "task.delete",
  "board.read",
  "board.configure",
  "task.move_to_column",
  "workspace.change.get",
  "workspace.change.list",
  "workspace.change.complete",
  "workspace.change.abandon",
  "workspace.retention.update",
  "workspace.integration.retry",
  "workspace.integration.verification.get",
  "workspace.integration.verification.configure",
  "task.complete",
  "task.request_review",
  // A plan with structure, not only flat Tasks. Proposal-gated, so it widens
  // nothing that skips approval; without it "make me a plan" could only
  // produce undated Tasks.
  "task.plan.propose",
  "project.reading.list",
  "project.reading.records",
  "project.reading.read",
  "research.list_operations",
  "research.start_acquisition",
  "research.read_result",
  "research.adopt_result",
  "research.cancel_acquisition",
  // "Accept it", said to the Assistant, is the same approval as the button.
  "proposal.list_pending",
  "proposal.decide",
  // Bringing a Source into the Project. Both are proposals (ADR 0017 §1), so
  // they widen nothing that skips approval.
  "project.monitoring.propose",
  "project.monitoring.propose_details",
  "project.monitoring.read",
  "project.source.propose_bind",
  "source.backfill.propose_start",
];

/**
 * The application management package's Agent tools (`plugins/official/applications`),
 * named one by one: a Run opened in a Project — a direct chat, a Room message, a
 * delegation from one, or a dispatched Task — may call them there. This is not a
 * plugin wildcard; another package's operations stay out until they are listed the
 * same way, and the list does not widen anything a listed tool is checked against:
 *
 * - the package must still be enabled for the instructing person and its tools
 *   reach a Project only through that Project's `bound` binding, the Run's own
 *   Project and the Agent's access Project (`assertPluginProjectTarget`, B53), so a
 *   Run never reaches another Project's records;
 * - sharing legacy private records and recording human review are person-only;
 * - a manual Room turn can start or save a private draft. Only a solo Run can
 *   preview the draft;
 * - shared contacts use the bound Project's read and write authority. The
 *   private contact records of a solo Run still need standing read consent
 *   (ADR 0030). A decision still goes through a proposal.
 *
 * `applicationsAgentToolsDb.test.ts` keeps this list equal to the package manifest's
 * Agent-eligible operations.
 */
export const PROJECT_APPLICATIONS_TOOL_ALLOWANCE: readonly PluginOperationId[] = [
  "plugin.applications.application.list",
  "plugin.applications.application.get",
  "plugin.applications.application.summary",
  "plugin.applications.application.create",
  "plugin.applications.application.update",
  "plugin.applications.application.update_status",
  "plugin.applications.application.record_submission",
  "plugin.applications.application.propose_status",
  "plugin.applications.funding.link",
  "plugin.applications.funding.unlink",
  "plugin.applications.deadline.add",
  "plugin.applications.deadline.update",
  "plugin.applications.deadline.remove",
  "plugin.applications.material.add",
  "plugin.applications.material.update",
  "plugin.applications.material.remove",
  "plugin.applications.material.link_note",
  "plugin.applications.material.add_source",
  "plugin.applications.material.remove_source",
  "plugin.applications.material.read_note",
  "plugin.applications.material.generate",
  "plugin.applications.material.get_generation",
  "plugin.applications.material.apply_generation",
  "plugin.applications.library.list",
  "plugin.applications.library.add",
  "plugin.applications.library.update",
  "plugin.applications.library.remove",
  "plugin.applications.contact.list",
  "plugin.applications.contact.list_events",
  "plugin.applications.contact.create",
  "plugin.applications.contact.update",
  "plugin.applications.contact.log_event",
  // What the owner's Gmail application updates recorded (their own rows). The command that records such a
  // fact, `plugin.applications.mail_fact.apply`, is never offered here: only the automation's own Run has it
  // (ADR 0034, `APPLICATION_UPDATE_RUN_TOOLS`), and the host refuses it to every other caller.
  "plugin.applications.mail_fact.list",
];

/**
 * What an Agent may do because Rainver dispatched it to work on a Task.
 *
 * A dispatched Run is not a conversation, which is what decides the shape of
 * this list. It carries the Project write surface a Task needs, and
 * `artifact.submit`. Do not omit `artifact.submit`. A
 * Task with a declared required output can never be satisfied by an agent
 * without it.
 *
 * `memory.remember` / `memory.revise` are deliberately absent even though
 * `CONVERSATION_TOOL_ALLOWANCE` carries them: remembering what someone told
 * you is a property of talking with them, and nobody is talking here — a
 * dispatched Run has no speaker whose entry it would be writing.
 *
 * Retrieval is present in its read-only forms only, and reads execute under
 * `instructed_by_user_id` exactly as they do everywhere else: an agent
 * dispatched by a person reaches what that person reaches, never more.
 */
const DISPATCH_BASE_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  "task.list",
  "task.create",
  "task.create_batch",
  "task.report",
  "task.handoff",
  "task.update",
  "task.set_status",
  "task.delete",
  "board.read",
  "board.configure",
  "task.move_to_column",
  "workspace.change.get",
  "workspace.change.list",
  "workspace.change.complete",
  "workspace.change.abandon",
  "workspace.retention.update",
  "workspace.integration.retry",
  "workspace.integration.verification.get",
  "workspace.integration.verification.configure",
  "task.complete",
  "task.request_review",
  "inquiry.list_threads",
  "inquiry.read_problem",
  "research.list_operations",
  "retrieval.brief",
  "retrieval.search",
];

/**
 * What a dispatched Task Run may call, on either kind of Host.
 *
 * Host kind is intentionally absent, as it is from
 * `conversationToolGrantInput`: a Project conversation on the built-in Host
 * already carries the broader `ROOM_CONVERSATION_TOOL_ALLOWANCE`, and this set
 * is narrower than that (no delegation, no memory, read-only retrieval, every
 * call executed under `instructed_by_user_id`). The tools reach the control
 * plane over the Run's tool surface; they add nothing to what the strict
 * namespace binds.
 *
 * `artifact.submit` is included on both. Every Host daemon uploads the Run's
 * `$RAINVER_OUTPUT_DIR` — the strict namespace binds the Run directory that
 * holds it read-write — and `recordOutputArtifacts` applies the declared type
 * and Task link whatever the trust mode.
 */
export function dispatchToolAllowance(): readonly ScenarioToolId[] {
  // A dispatched Run always works on a Project's Task.
  return [...DISPATCH_BASE_TOOL_ALLOWANCE, "artifact.submit", ...PROJECT_APPLICATIONS_TOOL_ALLOWANCE];
}

export const ROOM_CONVERSATION_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  ...ROOM_PROJECT_TOOL_ALLOWANCE,
  "room.settings.read",
  "room.defaults.save",
  "conversation.execution.preflight",
  "conversation.execution.initialize",
  "conversation.session_config.save",
  ...CONVERSATION_TOOL_ALLOWANCE,
];

/**
 * What a conversation Run declares and is allowed, given where it was opened.
 *
 * One function for every way a person or a Room talks to an Agent — a Room
 * message, a delegation the Room's Agent makes, a direct chat — so the
 * allowance is decided once. Do not give direct chat its own list, and do
 * not let a delegated child declare nothing: it then cannot call the actions
 * its parent was granted in the same conversation.
 *
 * Host kind is intentionally absent. It selects how the Run-scoped tool
 * surface is delivered, not what a conversation may do.
 */
export function conversationToolGrantInput(scope: {
  room_id?: string | null;
  project_id?: string | null;
  has_input_resources?: boolean;
  delegated?: boolean;
}): {
  capabilities_json: ScenarioToolId[];
  scenario_tool_allowance: readonly ScenarioToolId[];
} {
  // A Room is the Project's conversation surface; a direct chat opened in a
  // Project is the same conversation with one audience. Either way the
  // Project write surface belongs to the place, not to the Agent.
  const baseAllowance = scope.room_id || scope.project_id
    ? ROOM_CONVERSATION_TOOL_ALLOWANCE
    : CONVERSATION_TOOL_ALLOWANCE;
  const scopedAllowance = scope.delegated ? baseAllowance.filter(id=>!["room.defaults.save","conversation.execution.initialize","conversation.session_config.save"].includes(id)) : baseAllowance;
  // Project-bound package tools only where the Run has a Project to reach them in.
  const projectAllowance: readonly ScenarioToolId[] = scope.project_id
    ? [...scopedAllowance, ...PROJECT_APPLICATIONS_TOOL_ALLOWANCE]
    : scopedAllowance;
  const allowance = scope.has_input_resources
    ? [...projectAllowance, ...INPUT_RESOURCE_TOOL_ALLOWANCE]
    : projectAllowance;
  return { capabilities_json: [...allowance], scenario_tool_allowance: allowance };
}
