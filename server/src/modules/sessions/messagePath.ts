/**
 * The visible path of a conversation.
 *
 * `messages` is a tree: `parent_message_id` points at the message a row
 * replies to, and a parent with two children is two branches of the same
 * conversation (an edit-and-resend, a regenerate). `sessions.head_message_id`
 * names the newest message on the branch the conversation is currently on, so
 * the visible transcript is the head plus its ancestors — not every row of the
 * session in timestamp order, which would interleave abandoned branches with
 * the live one.
 *
 * The ancestry is materialized rather than walked. Each message carries
 * `branch_path` (the lineage of branches it belongs to, as a `/`-delimited
 * prefix) and `path_depth` (its position on that branch, from the session's
 * first message). A message is an ancestor-or-self of the head exactly when
 *
 *   head.branch_path LIKE message.branch_path || '%'  AND
 *   message.path_depth <= head.path_depth
 *
 * which the `(space_id, session_id, path_depth, id)` index answers as one
 * range scan — so a page read still stops at `LIMIT` rows. Walking
 * `parent_message_id` in a recursive CTE gives the same answer but has to
 * materialize the whole conversation before it can return any page of it.
 *
 * A session that has never branched is the degenerate case: one branch,
 * `branch_path = '/'`, and the range is every row it has.
 */

/** The lineage a session's first branch belongs to. */
export const ROOT_BRANCH_PATH = "/";

/**
 * A predicate restricting `<alias>` to the visible path of the session named
 * by `$<sessionParam>` in `$<spaceParam>`.
 *
 * Prefix alone is not enough. A fork's branch `/<depth>:<id>/` extends `/`, so
 * a plain prefix match would also admit the *sibling* messages that stayed on
 * `/` past the fork point — they share the ancestor branch but were never
 * ancestors of this head. The fork depth encoded in each segment is what
 * bounds them out: a message on an ancestor branch is on this path only if it
 * sits at or above the depth where the head's lineage left that branch.
 *
 * A session with no head has no visible path and matches nothing, which is
 * correct: it has no messages yet. (A session that has messages always has a
 * head — they are written in the same statement.)
 */
export function visibleMessagePathSql(input: {
  alias: string;
  spaceParam: string;
  sessionParam: string;
}): string {
  const { alias, spaceParam, sessionParam } = input;
  return `EXISTS (
    SELECT 1
      FROM sessions path_session
      JOIN messages path_head
        ON path_head.id = path_session.head_message_id
       AND path_head.space_id = path_session.space_id
       AND path_head.session_id = path_session.id
     WHERE path_session.id = ${sessionParam}
       AND path_session.space_id = ${spaceParam}
       AND ${alias}.path_depth <= path_head.path_depth
       -- starts_with, not LIKE: a branch segment is built from a message id,
       -- and LIKE would read a percent or underscore in one as a wildcard.
       -- Ids are UUIDs today, so this is defence rather than a live bug — but
       -- the predicate should not depend on that.
       AND starts_with(path_head.branch_path, ${alias}.branch_path)
       -- The ceiling: where the head's lineage forked away from this
       -- message's branch. Take the first segment of the head's path beyond
       -- this message's prefix, of the form depth:id, and its depth is the
       -- last depth the two shared. On the head's own branch there is no such
       -- segment and the ceiling is the head itself.
       AND ${alias}.path_depth <= COALESCE(
             NULLIF(split_part(
               split_part(
                 right(path_head.branch_path, -length(${alias}.branch_path)),
                 '/', 1),
               ':', 1), '')::int,
             path_head.path_depth)
  )`;
}

/**
 * Where a new message lands, given the message it replies to.
 *
 * Appending to the tip continues that branch. Replying to anything else forks:
 * the new message starts its own branch, whose segment records both the depth
 * the fork happened at and the message that started it. The depth is what lets
 * a read tell an ancestor of this branch from a sibling that stayed behind on
 * the parent branch (see `visibleMessagePathSql`); the id keeps two forks from
 * the same point distinct.
 */
export function childBranchPath(input: {
  parentBranchPath: string;
  parentIsTip: boolean;
  childMessageId: string;
  /**
   * The depth of the message being replied to — the last depth this branch
   * shares with the one it leaves. The read compares `path_depth <=` against
   * it, so it must name the fork point itself, not the first message past it.
   */
  parentDepth: number;
}): string {
  return input.parentIsTip
    ? input.parentBranchPath
    : `${input.parentBranchPath}${input.parentDepth}:${input.childMessageId}/`;
}
