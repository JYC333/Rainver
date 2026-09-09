# ADR 0020: Instance Update Through a Deployer Pull Loop

Date: 2026-09-07

## Status

Accepted and shipped 2026-09-07. Rewrites B41, B43, and B44 in
[BOUNDARIES](../BOUNDARIES.md); refines the "Credentials and deployment" row of
[ADR 0017](0017-authorization-by-cost-not-authorship.md) §1 for instance updates
without changing that ADR's rule. Current state lives in
[`modules/deployment.md`](../modules/deployment.md) and
[`architecture/OPERATIONS_AND_SAFETY.md`](../architecture/OPERATIONS_AND_SAFETY.md);
the real-machine acceptance is the one open item, in
[`tasks/deferred-register.md`](../tasks/deferred-register.md). This document holds
the decision and its reasoning only.

## Context

Production runs the four images CI publishes to GHCR
(`ghcr.io/jyc333/rainver-<name>`, tags `stable` / `edge` / `sha-<commit>`);
`start.sh --prod` pulls, migrates behind a `pg_dump`, and recreates. Updating
still needs a person on the machine to run that command.

The deployer sidecar is the only container with docker.sock. Its Unix socket
is private, it accepts three argument-less jobs, and the product routes under
`/api/v1/deployments` fail closed with 501. B41 said no server service submits
deployer jobs; B43 said a future product trigger must verify a human-approved
proposal; B44 described the deployer's read-write repository mount as
host-equivalent authority.

Two things changed. Pulling replaced building, so the update no longer needs a
git checkout writable from the deployer, and the job the deployer must run is
now short and fixed: pull, wait for Runs, dump, migrate, recreate, health.
And the proposal cycle B43 anticipated has no reviewer: an instance has one
administrator, and a Proposal reviewed by its own author is a form, not a
control. ADR 0017 already states the actual rule — a person approves each
high-cost action explicitly and the approval is durable — without requiring
that the approval take the Proposal shape.

## Decision

### 1. The server never gains Docker authority; the deployer pulls work

The server holds a `deployment_jobs` table and nothing else. The deployer
polls the server over the Compose network with the existing internal token
(`SERVER_INTERNAL_TOKEN`, `x-rainver-internal-token`) and executes what it
finds. The deployer's Unix socket, its argument-less allowlist, and the rule
that nothing on an agent, automation, job, or scheduler path can reach it are
unchanged. The polling channel is a second entry, not a widening of the first:
it carries exactly two job types, `update` and `check_update`, both without
caller arguments.

### 2. The administrator's request is the approval

Only the instance administrator (`INSTANCE_ADMIN_EMAIL`) can create a
deployment job. Creating it is the person's explicit, per-instance approval
under ADR 0017 §1; the job row carries who requested it, when, the tag and
digests involved, and every stage's outcome. No Proposal, no second
confirmation. The administrator said what a "breaking" update would need to
be confirmed against, and nothing in the current release model can name one:
there are no version numbers or release notes, and a pending migration is a
backend step behind a mandatory dump, not a decision for the person. When a
release model exists that can express "this one needs a look", a confirmation
step can be added to the same job flow.

A job is created only when something will claim it. An `update` whose deployer
has not beaten in three minutes is refused rather than queued, because a queued
update is not inert: it defers every unattended Run from the moment the row
exists, and without the refusal a dead deployer would silently pause scheduled
work until the sweep failed the job half an hour later. `check_update` has no
such cost and may wait.

Agents, automations, and Proposal appliers cannot create deployment jobs. That
part of B43 is kept verbatim: the hard gate in ADR 0017 stays a hard gate; what
changed is the shape the human approval takes.

### 3. Update means "latest on the configured channel"

The job pulls whatever `RAINVER_IMAGE_TAG` in the prod `.env` resolves to
(default `stable`) and records the digests it actually pulled. Switching
channel and rolling back to a `sha-<commit>` tag stay host operations that
edit `.env` and run `start.sh --prod`. The deployer never writes `.env`.
Rolling backward across a migration is a restore decision a person makes from
the pre-migrate dump; the UI does not offer it.

### 4. Soft drain before recreation

While an `update` job is queued or draining, the server refuses to admit new
Runs whose trigger origin is automation, autonomous, job, or system, and
defers them; conversation-originated Runs still run. The deployer waits until
the server reports no running Runs or the job's drain timeout (default ten
minutes) elapses, then proceeds. Runs still running at that point are handled
by the existing job-lease retry and orphan rules, not by anything new.

### 5. A failed stage stops the job; nothing rolls back automatically

Stages are pull, drain, backup, migrate, recreate, health. Each records its
start, end, and log tail on the job. Failure at any stage ends the job as
`failed` with that stage named; the UI shows it and the dump path. The first
three stages touch no running container. Recovery is the documented host
procedure. Automatic restore from a half-applied migration and automatic
re-`up` of the previous digest are deliberately not built until real failures
have been observed.

Migrating before recreating puts one constraint on a release: between those two
stages the *previous* server is still serving conversation Runs against the new
schema. A release's migrations must therefore be readable by the build they
replace — expand now, contract in a later release — which is stated as a rule in
B59. Recreating first would instead serve the new build against the old schema,
and that window is not seconds but however long the migration takes.

A release whose migration cannot satisfy that constraint is not installable
from here. Such a migration is marked `-- rainver:maintenance`, and the `pull`
stage refuses the job the moment the new image is on disk and its chain can be
read — before anything has been drained or recreated — naming
`./ops/scripts/start.sh --maintenance` instead (ADR 0016 §10). That
command is an operator step on the host: it stops the applications, keeps
PostgreSQL, dumps, migrates, and starts again, and on failure leaves the
applications stopped with the dump kept. A UI-triggered offline upgrade would
need an executor that survives stopping the server that requested it, and is
deliberately not built here. The distinction is compatibility with the running
version, not whether a database changes: an ordinary migration stays a UI
update.

### 6. The deployer does not update itself

The recreate stage names `server`, `frontend`, and `sandbox-runner`. The
deployer's own image changes only when a person runs `start.sh --prod` on the
host. Its repository mount shrinks from the whole checkout read-write to
`ops/` read-only, which is all the update needs: the compose file, `.env`,
and `migrate.sh` with its library. B44's "read-write repository mount" wording
goes with it.

That mount is the host checkout, so the plumbing an update runs — the compose
files, the ops scripts, `migrate.sh` — moves with the deployer rather than with
the images, and neither moves by pressing Update. An update therefore carries
exactly the four images and nothing else. A release that changes the compose
definition, an ops script, or the server↔deployer wire contract needs a host
step (`git pull && ops/scripts/start.sh --prod`), and the instance must say so
rather than run new images on old plumbing. The signal cannot be the commit:
because an update never recreates the deployer, its commit differs from the
server's after every update, and an alarm that is always on is no alarm. Every
image therefore carries `com.rainver.deployment-surface`, a content digest of
`deployer/` and `ops/`; a running deployer whose surface differs from the
server's is `deployer_behind`, and the panel asks for that command. Making the update carry `ops/` would mean the deployer writing
the checkout it runs from, which is exactly the authority §6 removes; making it
recreate the deployer would mean a container replacing itself mid-job. Both are
refused, and the visible skew is the price.

### 7. Observation flows from the deployer, on a heartbeat

Every thirty seconds the deployer reports what it can see through
docker.sock — the image digest each service is running — plus the last
remote-check result, and receives any pending job in the same response. The
remote check of the server image on the configured tag runs once a day and on
demand through the `check_update` job. "An update
is available" is the remote server digest differing from the running one; all
four images move together, so one comparison is enough. The server never
contacts the registry.

## Consequences

- B41, B43, and B44 are rewritten; `deploymentGroup.test.ts` stops asserting
  501 and asserts the new authority rules instead.
- One new table pair (`deployment_jobs`, `deployment_job_events`) and one
  observation row; internal routes under `/internal/deployment/`; admin routes
  under `/api/v1/deployments/`; two new deployer job types executed by a poll
  loop that coexists with the socket server.
- A new admission refusal reason in the automation path, treated as a deferral.
- The deployer needs the host-side mode root path to hand Compose (its own
  mount path is not what the Docker daemon resolves); the plan carries this.
- The update carries images only. `ops/` and the deployer image move by a host
  command, so the instance reports `deployer_behind` instead of running new
  images on old plumbing, and a change to the internal wire contract is a
  host-step release.
- The four GHCR packages being public is safe for this design: authority comes
  from runtime mounts, not image contents, and only a push to `dev`/`master`
  can publish. Recording pulled digests on the job keeps an immutable record
  of what ran even though `stable` moves.

## Revision history

- 2026-09-08 — §5 gained the one release shape this path cannot install: a
  migration marked `-- rainver:maintenance` removes something the running build
  still reads, so the `pull` stage refuses the job and names the offline
  maintenance command (ADR 0016 §10). The decision — the deployer pulls
  and the server never gains Docker authority — is unchanged.
- 2026-09-07 — a review of the shipped implementation added three things this
  document had left implicit and one it had stated too strongly. §2 now says a
  job is refused when no deployer is reporting, because a queued update pauses
  unattended work; §5 states the release constraint that migrating before
  recreating implies (also written into B59); §6 says that `ops/` moves with the
  deployer rather than with the images, that this makes a compose, ops-script or
  wire-contract change a host-step release, and that `deployer_behind` — a content
  digest of `deployer/` and `ops/` stamped on every image, not the commit — is
  how the instance says so. The claim that the deployer never touches the database
  was removed from `modules/deployment.md`: the `migrate` stage dumps and
  migrates it through Compose. No decision changed.
- 2026-09-07 — corrected §7: this document originally named
  `docker manifest inspect` as the remote check. That command reports a tag's
  *child* platform manifests, and every image the build publishes is an index
  (its provenance attestation is a second manifest), so its answer could never
  equal the index digest a pull records. The deployer hashes the manifest bytes
  the registry serves instead. The decision — the deployer reads the remote
  digest and the server never contacts the registry — is unchanged.

## Non-goals

Channel selection or rollback from the UI; automatic rollback; a breaking-
update confirmation; per-module image versions (host daemon keeps its own
rolling channel because it runs on other machines); deployer self-update
through the job; any path for an Agent to request an update.
