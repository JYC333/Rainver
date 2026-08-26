import type { SystemActionId } from "@rainver/protocol";

/**
 * Scenario tool allowances.
 *
 * `buildRunToolGrants` intersects what a Run declares with what it is
 * *allowed*, and fails closed when the allowance is missing. Until now the
 * allowance could only come from one place: the immutable AgentVersion's
 * `tool_permissions_json`. That models a tool as a property of the Agent —
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
 * The Inquiry entries are proposal-gated: the Agent drafts, and the durable
 * write waits on a human accepting it. `agent.delegate` and
 * `research.start_acquisition` are both visible, directly-executed
 * coordination actions — `agent.delegate` is independently constrained by
 * the Room's one-level/two-specialist delegation budget, and
 * `research.start_acquisition` is idempotency-guarded rather than
 * proposal-gated (room-advancement-reliability-plan Phase 4: the Thread was
 * already human-accepted at creation). `research.cancel_acquisition` is its
 * stop lever, listed here so a Room notification about running research
 * always has a matching in-Room action — a report the user can
 * only act on by leaving for the web UI is the interruption the reform
 * removed, moved rather than deleted. The two are not mutually exclusive —
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
export const ROOM_CONVERSATION_TOOL_ALLOWANCE: readonly SystemActionId[] = [
  "project.propose_definition",
  "inquiry.propose_thread",
  "inquiry.record_conclusion",
  "inquiry.promote_knowledge",
  "agent.delegate",
  "research.start_acquisition",
  "research.cancel_acquisition",
];
