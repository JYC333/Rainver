-- rainver:maintenance
-- Work a person's Room turn authorized has no total handoff/turn limit; it is
-- counted and reminded (modules/rooms.md, "Task collaboration"). This one-time
-- conversion rewrites every stored task collaboration the earlier release
-- accepted (its strict finite / reminder union, commit 4c6e23c0) into the
-- single current shape: Task, participants, coordinator, offsets and reminder
-- progress are kept; the mode, finite cap, interim reminder request, stored
-- thresholds and conversion marker are removed. A legacy record without
-- `declared_at` gets its container's creation time, which is exactly the
-- whole-container cancellation rule it had. `collaboration_history` is audit
-- and stays verbatim.
-- Only a record that release accepted is converted: every key must belong to
-- one of its two shapes and hold a value it accepted (non-empty ids, distinct
-- non-empty participants, integer offsets >= 0, a cap of 1..128, its datetime
-- rule for `declared_at`, increasing positive thresholds, literal markers).
-- Anything else, e.g. `max_delegations: 0` or a reminder without thresholds,
-- is left as it is, so it still fails closed. Each check is guarded by CASE
-- on the JSON type, so a value of the wrong type is false, never a cast error.
-- Numbers are judged as that release read them: `JSON.parse` turns the stored
-- decimal into the nearest double (±Infinity from 2^1024 - 2^970 up, ±0 at
-- 2^-1075 and below), then zod checks that double. `j.ns` holds those doubles
-- (NULL for a non-number or an infinity): PostgreSQL's numeric -> float8 cast
-- rounds the same way and is only reached inside those bounds, where it cannot
-- raise out-of-range. So 0.99999999999999999999 is the integer 1, and
-- 9007199254740992 and 9007199254740993 are the same threshold.
-- The running earlier release cannot read the converted records (it would
-- refuse them as invalid), hence the maintenance marker.
WITH legacy AS (
  SELECT g.space_id, g.id, g.created_at, g.budget_json->'collaboration' AS c
    FROM agent_run_groups g
   WHERE jsonb_typeof(g.budget_json->'collaboration') = 'object'
), accepted AS (
  SELECT legacy.* FROM legacy
   WHERE CASE WHEN jsonb_typeof(c) <> 'object' THEN false ELSE
     NOT EXISTS (SELECT 1 FROM jsonb_each(c) f CROSS JOIN LATERAL (SELECT ARRAY(
         SELECT CASE WHEN jsonb_typeof(e.v) <> 'number' THEN NULL
                     WHEN abs(e.v::numeric) >= power(2::numeric, 1024) - power(2::numeric, 970) THEN NULL
                     WHEN abs(e.v::numeric) * power(2::numeric, 1075) <= 1 THEN 0::float8
                     ELSE e.v::numeric::float8 END
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE jsonb_build_array(f.value) END)
                WITH ORDINALITY e(v, i) ORDER BY e.i) AS ns) j
      WHERE NOT CASE
       WHEN f.key IN ('task_id', 'coordinator_agent_id') THEN
         CASE WHEN jsonb_typeof(f.value) = 'string' THEN f.value #>> '{}' <> '' ELSE false END
       WHEN f.key = 'participant_agent_ids' THEN
         CASE WHEN jsonb_typeof(f.value) <> 'array' THEN false
              WHEN jsonb_array_length(f.value) < 1 THEN false
              WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(f.value) p
                            WHERE CASE WHEN jsonb_typeof(p.value) = 'string' THEN p.value #>> '{}' = '' ELSE true END) THEN false
              ELSE (SELECT count(DISTINCT p.value #>> '{}' COLLATE "C") = count(*) FROM jsonb_array_elements(f.value) p) END
       WHEN f.key = 'declared_at' THEN
         -- zod 3 `z.string().datetime({ offset: true })`, ASCII digits.
         CASE WHEN jsonb_typeof(f.value) = 'string' THEN f.value #>> '{}' ~ ('^'
           || '(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29'
           || '|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))'
           || 'T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|([+-][0-9]{2}:?[0-9]{2}))$')
         ELSE false END
       -- `z.number().int()`: a finite whole double.
       WHEN f.key IN ('delegations_offset', 'turns_offset', 'reminder_notified_through') THEN
         CASE WHEN jsonb_typeof(f.value) = 'number' AND j.ns[1] IS NOT NULL
           THEN j.ns[1] = trunc(j.ns[1]) AND j.ns[1] >= 0 ELSE false END
       WHEN f.key IN ('max_delegations', 'converted_from_max_delegations') THEN
         CASE WHEN jsonb_typeof(f.value) = 'number' AND j.ns[1] IS NOT NULL
           THEN j.ns[1] = trunc(j.ns[1]) AND j.ns[1] BETWEEN 1 AND 128 ELSE false END
       WHEN f.key = 'reminder_requested' THEN f.value = 'true'::jsonb
       WHEN f.key = 'mode' THEN f.value = '"reminder"'::jsonb
       WHEN f.key = 'reminder_thresholds' THEN
         CASE WHEN jsonb_typeof(f.value) <> 'array' THEN false
              WHEN jsonb_array_length(f.value) NOT BETWEEN 1 AND 8 THEN false
              ELSE NOT EXISTS (SELECT 1 FROM generate_subscripts(j.ns, 1) k
                                WHERE CASE WHEN j.ns[k] IS NULL THEN true
                                           ELSE j.ns[k] <> trunc(j.ns[k]) OR j.ns[k] <= 0 OR (k > 1 AND j.ns[k] <= j.ns[k - 1]) END) END
       ELSE false END)
     AND c ? 'task_id' AND c ? 'participant_agent_ids' AND c ? 'coordinator_agent_id'
     -- finite: a cap and only finite keys; reminder: mode and thresholds and only reminder keys.
     AND ((c ? 'max_delegations'
           AND NOT c ?| ARRAY['mode', 'reminder_thresholds', 'reminder_notified_through', 'converted_from_max_delegations'])
       OR (c ? 'mode' AND c ? 'reminder_thresholds' AND NOT c ?| ARRAY['max_delegations', 'reminder_requested']))
   END
)
UPDATE agent_run_groups g
   SET budget_json = jsonb_set(g.budget_json, '{collaboration}', jsonb_build_object(
         'task_id', a.c->'task_id',
         'participant_agent_ids', a.c->'participant_agent_ids',
         'coordinator_agent_id', a.c->'coordinator_agent_id',
         'delegations_offset', COALESCE(a.c->'delegations_offset', '0'::jsonb),
         'turns_offset', COALESCE(a.c->'turns_offset', '0'::jsonb),
         'declared_at', COALESCE(a.c->'declared_at', to_jsonb(to_json(a.created_at)#>>'{}')),
         'reminder_notified_through', COALESCE(a.c->'reminder_notified_through', '0'::jsonb)))
  FROM accepted a
 WHERE g.space_id = a.space_id AND g.id = a.id;
--> statement-breakpoint
-- A container rooted in a person's own Room turn no longer has a soft budget
-- for its own temporary delegation: its one-time soft-notice flag is removed
-- (the posted notice stays). A discussion keeps its bounds and its notice, so
-- a container any discussion group charges keeps the flag
-- (rooms/delegationBudget.ts, `roomBudgetContainer`).
UPDATE agent_run_groups g
   SET budget_json = g.budget_json - 'soft_budget_notified'
 WHERE g.budget_json ? 'soft_budget_notified'
   AND EXISTS (SELECT 1 FROM runs r WHERE r.space_id = g.space_id AND r.id = g.root_run_id
     AND r.trigger_origin = 'manual' AND r.parent_run_id IS NULL)
   AND NOT EXISTS (SELECT 1 FROM agent_run_groups d WHERE d.space_id = g.space_id AND d.discussion_id IS NOT NULL
     AND COALESCE(d.budget_json->>'container_group_id', d.id) = g.id);
