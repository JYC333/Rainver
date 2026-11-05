# Problem model one-time cutover

[ADR 0027](../decisions/0027-problem-engine-research-separation.md) decision 6
keeps no runtime compatibility: application code supports only the current
problem model. Applied SQL remains migration history; the canonical migrator,
backup and restore mechanisms remain supported. There is no problem-upgrade
runtime audit CLI, backfill or read-time kind/timestamp inference.

## Offline boundary

The active formal maintenance migration is `0009_problem_engine`. Its ordered
historical sections are preserved by ADR0025, including original backfills and
ACL repairs. A final retirement section deletes only dedicated imported stage
events and drops the dedicated archive table; the application has neither a
model nor a reader for them. Existing instances require a verified private
export of those rows and their reference context plus a recovery backup before
this explicitly authorized removal. Normal Task events and cognitive history
are retained. A normal event referencing a retired event stops removal for
operator review instead of silently creating a dangling reference.

Applied source chains are retained only in external recovery archives. Convert
with the canonical frozen source/target pair; do not edit applied checksums.
Migration SQL retains historical names as version records, not runtime support.

The historical authorized test baseline was schema0008, with zero legacy Steps and Research
Operations. One old Iteration remains an Iteration; it is not a new judgment.
Unknown old Step facts on another database abort the cutover transaction and
require an independently reviewed offline conversion. No kind-based Research
binding is manufactured. Independent Research/monitoring remains supported.

## Instance maintenance

Use [COMMANDS](../COMMANDS.md), [operations](OPERATIONS_AND_SAFETY.md) and
[backup/restore](../../docs/BACKUP_AND_RESTORE.md). Verify test identity, quiesce
writers without killing another person's Run, stop app services, take the full
system backup and the pre-migration dump, migrate, then start images built from
the matching new source. PostgreSQL stays running; no database reset is involved.
Health alone is insufficient: compare Task/relationship/actor/output/Run/Plan/
Source IDs and counts, the expected zero retired rows/table and normal history readability before resuming.

A control-plane maintenance conversation on an independent remote Host is not
unattended work. It must not be falsely marked finished to satisfy drain; any
switch must preserve the remote execution and its identity. Other active work
still prevents the switch. Ordinary maintenance drain remains the default.

On failure preserve the stopped state and backup. SQL transaction rollback,
full backup restoration and application rollback are distinct operations. Do
not downgrade the application alone after dropping old tables/columns. This
procedure does not authorize prod/dev rollout or unrelated history deletion.


Cutover preflight: stop before deployment and inventory the target database
**offline**. The original0017 section deliberately fails if any Step has a non-modern
method; do not guess a conversion or start an old writer against the new schema.
Only test maintenance is authorized for this cleanup. Dev/prod require separate
authorization, offline inventory, backup and an explicitly reviewed conversion;
they must not inherit test's zero-legacy-Step assumption. The original0020 section preserves imported
history's canonical top-level ACL/provenance fields. Old applied source files
are frozen outside the activity chain; existing source histories require the
ADR0025 converter and frozen pair, never ordinary up or checksum overrides.
