import { PERSON_ONLY_TASK_STATUSES } from "@rainver/protocol";
import { assertSqlIdentifier } from "../access/contentAccessSql.js";

/**
 * Who is on the hook for a Task, as SQL.
 *
 * Claim beats assignment beats authorship, floored at the Project owner, and
 * the chain is read as a whole rather than per column: an Agent that claimed a
 * Task is the responsible party even when a person is assigned, because the
 * person handed it over.
 *
 * This lives in one place because three surfaces ask the same question — the
 * attention adapter ("interrupt whom"), the Board ("show whose card"), and the
 * cross-Project task list ("what is mine") — and a chain that disagrees between
 * them would send a person to a list that does not contain the thing they were
 * told to look at.
 */

/**
 * States that mean a person has to act, so an Agent cannot be the responsible
 * party in them. `waiting_for_review` is defined as "a person has to decide"
 * and `blocked` as "held up by something else" — in both, work is precisely
 * what an Agent is not doing.
 */
export const PERSON_ONLY_STATUSES = PERSON_ONLY_TASK_STATUSES;
const PERSON_ONLY_STATUS_SQL = `(${PERSON_ONLY_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/**
 * The responsible **person**, or NULL when an Agent holds the work.
 *
 * NULL is meaningful rather than missing: an Agent-held Task belongs in "the
 * Agent is working" and interrupts nobody — *while the Agent is working*. The
 * moment the Task lands in a state that requires a decision, the chain steps
 * past the Agent to the person behind it (assigned, else author, else the
 * Project owner), because there is otherwise nobody to interrupt and the Task
 * waits forever: the attention adapter, the Board's "needs me" filter and the
 * cross-Project task list all key on this being a person.
 *
 * The claim itself is left intact. Who did the work and who must now decide
 * are different questions, and overwriting the first to answer the second
 * would lose the only record of which Agent to hand it back to.
 */
export function responsibleUserSql(taskAlias: string, projectAlias: string): string {
  assertSqlIdentifier(taskAlias, "taskAlias");
  assertSqlIdentifier(projectAlias, "projectAlias");
  return `CASE
    WHEN ${taskAlias}.claimed_by_user_id IS NOT NULL THEN ${taskAlias}.claimed_by_user_id
    WHEN ${taskAlias}.claimed_by_agent_id IS NOT NULL
         AND ${taskAlias}.status NOT IN ${PERSON_ONLY_STATUS_SQL} THEN NULL
    WHEN ${taskAlias}.assigned_user_id IS NOT NULL THEN ${taskAlias}.assigned_user_id
    WHEN ${taskAlias}.assigned_agent_id IS NOT NULL
         AND ${taskAlias}.status NOT IN ${PERSON_ONLY_STATUS_SQL} THEN NULL
    WHEN ${taskAlias}.created_by_user_id IS NOT NULL THEN ${taskAlias}.created_by_user_id
    ELSE ${projectAlias}.owner_user_id
  END`;
}

/**
 * The responsible **Agent**, or NULL when a person holds the work.
 *
 * Mirrors the person chain, including its handback: in a state that requires a
 * decision the Agent is not the responsible party, so exactly one of the two
 * is non-NULL at any time and no surface has to break the tie.
 */
export function responsibleAgentSql(taskAlias: string): string {
  assertSqlIdentifier(taskAlias, "taskAlias");
  return `CASE
    WHEN ${taskAlias}.status IN ${PERSON_ONLY_STATUS_SQL} THEN NULL
    WHEN ${taskAlias}.claimed_by_user_id IS NOT NULL THEN NULL
    WHEN ${taskAlias}.claimed_by_agent_id IS NOT NULL THEN ${taskAlias}.claimed_by_agent_id
    WHEN ${taskAlias}.assigned_user_id IS NOT NULL THEN NULL
    ELSE ${taskAlias}.assigned_agent_id
  END`;
}

export interface ResponsibleActorRow {
  responsible_user_id: string | null;
  responsible_agent_id: string | null;
  responsible_user_name?: string | null;
  responsible_agent_name?: string | null;
}

export function responsibleActorOf(row: ResponsibleActorRow): {
  kind: "user" | "agent" | null;
  id: string | null;
  display_name: string | null;
} {
  if (row.responsible_user_id) {
    return { kind: "user", id: row.responsible_user_id, display_name: row.responsible_user_name ?? null };
  }
  if (row.responsible_agent_id) {
    return { kind: "agent", id: row.responsible_agent_id, display_name: row.responsible_agent_name ?? null };
  }
  return { kind: null, id: null, display_name: null };
}
