/**
 * The ACP permission decision: find an `allow_once` option, fall back to
 * `allow_always`, otherwise cancel. It is a value callers can log, and it
 * states its own justification (`preauthorized_by`). Do not leave it as an
 * implicit side effect of receiving a message.
 *
 * The one implementation today always pre-authorizes, because every current
 * dispatch path (server-host sandboxed Run, remote trusted-host Run) is
 * headless — there is no human present mid-run to answer an interactive
 * prompt. A gate that can actually suspend a Run for a human decision is
 * deferred (`backlog.md`): it needs suspend/notify/resume machinery this
 * policy does not have.
 */

interface PermissionOptionInput {
  option_id: string | null;
  kind: string | null;
}

export type PermissionDecisionOutcome =
  | { outcome: "selected"; option_id: string }
  | { outcome: "cancelled" };

interface PermissionDecision {
  outcome: PermissionDecisionOutcome;
  preauthorized_by: "dispatch_approval_preset";
}

/**
 * Headless dispatch has no human in the loop, so the only reachable decision
 * is a pre-authorized allow — but it is now a named, recorded fact rather
 * than a silent default. An option counts only if it names a non-empty
 * `option_id`; a same-kind option missing one is treated as absent, exactly
 * as the pre-extraction inline logic did.
 */
export function decidePermission(options: PermissionOptionInput[]): PermissionDecision {
  const allowOption = options.find((option) => option.kind === "allow_once" && option.option_id)
    ?? options.find((option) => option.kind === "allow_always" && option.option_id);
  return {
    outcome: allowOption
      ? { outcome: "selected", option_id: allowOption.option_id! }
      : { outcome: "cancelled" },
    preauthorized_by: "dispatch_approval_preset",
  };
}

export interface PermissionDecisionRecord {
  tool_kind: string | null;
  decision: PermissionDecisionOutcome;
  preauthorized_by: "dispatch_approval_preset";
}
