/**
 * The reset generation of an Agent's state on a Host (`agent.host_state.reset`, ADR 0036 §15).
 *
 * A reset archives every CLI profile the Agent has on that Host, so a vendor session any earlier launch of the Agent
 * there started or continued no longer exists, whenever that launch's report arrives. The generation is the number of
 * such resets ever admitted (`host_command_intents`, never deleted while the Host exists): read when a launch nonce is
 * bound (`PgRunRepository.bindAttemptLaunch`) and kept in that launch's record (`host_reset_generation`). A record whose
 * generation is behind the current one is a launch from before a later reset: its session — reported as the thread's
 * pointer or parked on the Run, however late the report — is never resumed. These are SQL fragments over caller-named
 * expressions so the judgement is part of the caller's own statement (one snapshot). No imports: the run repository and
 * the thread repository both use it.
 */

/**
 * The transaction-scoped advisory lock of an Agent's state on a Host (ADR 0036 §16). The reset admission takes it
 * exclusively before it scans and retires anything and holds it until its intent commits
 * (`lockAgentHostResetAdmission`); the launch fence (`agentHostResetFence`) and a park
 * (`PgRunRepository.recordParkedHostThreadSession`) take it shared, so each either commits wholly before the reset's
 * scan, or runs wholly after its intent is visible. One key format for all of them.
 */
export function agentHostResetLockKey(hostId: string, agentId: string): string {
  return `agent-host-reset:${hostId}:${agentId}`;
}

/** SQL integer: how many resets of Agent `agent`'s state on Host `host` were ever admitted. */
export function agentHostResetGenerationSql(host: string, agent: string): string {
  return `(SELECT count(*)::int FROM host_command_intents reset_intent
            WHERE reset_intent.kind = 'agent_host_state_reset'
              AND reset_intent.host_id = ${host} AND reset_intent.agent_id = ${agent})`;
}

/**
 * SQL boolean: launch record `record` (a `run_attempts.launch_isolation_json`, or a Run's frozen copy of one) of a
 * launch of Agent `agent` predates a reset of that Agent on the record's Host. A record bound before generations were
 * kept is judged on time instead: stale when a reset was admitted at or after `attemptCreatedAt`, the
 * `run_attempts.created_at` of the attempt the record is on (ADR 0036 §16). That column is written once, when the
 * attempt is created, and is never later than any launch of it; `started_at` is not usable here, because a claim of the
 * same attempt after an approval rewrites it to the re-claim's time. Null — the attempt cannot be found — means there is
 * no evidence of when it launched, and then any reset makes it stale. No record at all is not stale here — the caller's
 * other rules decide what an unrecorded launch may do.
 */
export function launchRecordResetSql(record: string, agent: string, attemptCreatedAt: string): string {
  return `(jsonb_typeof(${record}) = 'object' AND CASE
     WHEN ${record} ? 'host_reset_generation'
       THEN ${agentHostResetGenerationSql(`(${record}->>'host_id')`, agent)} > COALESCE((${record}->>'host_reset_generation')::int, 0)
     ELSE EXISTS (SELECT 1 FROM host_command_intents reset_intent
                   WHERE reset_intent.kind = 'agent_host_state_reset'
                     AND reset_intent.host_id = (${record}->>'host_id') AND reset_intent.agent_id = ${agent}
                     AND reset_intent.created_at >= COALESCE(${attemptCreatedAt}, '-infinity'::timestamptz))
   END)`;
}
