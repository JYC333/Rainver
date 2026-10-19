# Memory Model

The current memory model is documented in
[`.agent/architecture/MEMORY_MODEL.md`](../.agent/architecture/MEMORY_MODEL.md).

The isolation boundary is **Space** (not tenant). There are no `tenant_id` columns
in the current schema; every memory record is scoped by `space_id` and
`owner_user_id`. See [`.agent/decisions/0001-space-model.md`](../.agent/decisions/0001-space-model.md)
for the Space boundary.
