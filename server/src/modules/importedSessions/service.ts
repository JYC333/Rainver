import {
  AMBIENT_DEFAULT_MAX_SESSIONS,
  AMBIENT_DEFAULT_WINDOW_DAYS,
  AMBIENT_TRIM_LIMITS,
  AmbientImportPolicySchema,
  AmbientSessionImportSchema,
  OWN_INSTALLATION,
  type AmbientImportPolicy,
  type AmbientImportPolicyEntry,
  type AmbientSessionCount,
  type AmbientSessionImport,
  type AmbientUsage,
} from "@rainver/protocol";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../../config.js";
import { HttpError, dbPool, withQueryableTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { contentDecisionFromDb } from "../access/contentAccessQuery.js";
import { PgWorkspaceLocationRepository } from "../projectFolders/workspaceLocations.js";
import { sharedHostConnectionRegistry } from "../hosts/connectionRegistry.js";
import { acpRuntimeProbes } from "../hosts/runtimeProbes.js";
import { recordAttributedUsageObservation, resolveUsageObservationAttribution } from "../usage/index.js";
import { PgActivityRepository } from "../activity/repository.js";
import { PgImportedSessionRepository, type ImportedSessionRow } from "./repository.js";

/**
 * A ceiling on one sync's in-flight sessions.
 *
 * The daemon is a machine the person owns, not a trusted peer: its reports are
 * parsed, and their volume is bounded, so a misbehaving or compromised host
 * cannot fill this process's memory with one request.
 */
const MAX_SESSIONS_PER_SYNC = 200;

/**
 * A usage event's identity, derived from what it says rather than where it
 * appeared. Two genuinely identical events in one replay are indistinguishable
 * and collapse to one, which is the correct outcome for a ledger keyed on
 * idempotency.
 */
function usageFingerprint(usage: AmbientUsage): string {
  return createHash("sha256").update(JSON.stringify([
    usage.model ?? null,
    usage.input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
    usage.reasoning_tokens ?? 0,
    usage.occurred_at ?? null,
  ])).digest("hex").slice(0, 32);
}

/** What a sync did, per runtime, for the caller and for the batch pointer. */
export interface AmbientSyncReport {
  location_id: string;
  adapter_type: string;
  installation: string;
  sessions_seen: number;
  sessions_written: number;
  records_inserted: number;
  records_unchanged: number;
  records_conflicted: number;
  marked_gone: number;
  usage_events: number;
  /** Ledger writes that were rejected; a short total must not look like no usage. */
  usage_failures: number;
  /** Sessions a daemon reported in a shape this server does not accept. */
  malformed_sessions: number;
  /** Sessions that could not be written; the rest of the sync still stands. */
  failed_sessions: number;
  error: string | null;
}

interface DispatchTarget {
  location_id: string;
  project_folder_id: string;
  space_id: string;
  project_id: string;
  execution_host_kind: string;
  host_id: string;
  host_owner_user_id: string | null;
  host_online: boolean;
}

export class ImportedSessionService {
  private readonly sessions: PgImportedSessionRepository;
  private readonly locations: PgWorkspaceLocationRepository;

  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {
    this.sessions = new PgImportedSessionRepository(db);
    this.locations = new PgWorkspaceLocationRepository(db);
  }

  static fromConfig(config: ServerConfig): ImportedSessionService {
    if (!config.databaseUrl) throw new HttpError(502, "SERVER_DATABASE_URL is required");
    return new ImportedSessionService(dbPool(config), config);
  }

  /**
   * Resolves a Location for an ambient-import operation.
   *
   * Three checks, and each rejects a different mistake: the Location must be
   * on a remote host (a server-host checkout runs managed profiles and has no
   * ambient history at all), the caller must be that host's registered owner
   * (ADR 0016's hard rule — a host serves only its owner, and its history is
   * the owner's), and the caller must be able to write the Project the
   * history would land in.
   */
  private async requireTarget(identity: SpaceUserIdentity, locationId: string): Promise<DispatchTarget> {
    const target = await this.locations.resolveDispatchTarget(locationId);
    if (!target || target.space_id !== identity.spaceId) throw new HttpError(404, "Workspace location not found");
    if (target.execution_host_kind !== "remote") {
      throw new HttpError(422, "Ambient session import applies to a paired host's own CLI history, not to a server-host location");
    }
    if (target.host_owner_user_id !== identity.userId) {
      throw new HttpError(403, "Only the host owner may import that machine's session history");
    }
    await assertProjectWriter(this.db, identity.spaceId, target.project_id, identity.userId);
    return target;
  }

  async policy(identity: SpaceUserIdentity, locationId: string): Promise<AmbientImportPolicy> {
    await this.requireTarget(identity, locationId);
    return this.readPolicy(locationId);
  }

  private async readPolicy(locationId: string): Promise<AmbientImportPolicy> {
    const result = await this.db.query<{ ambient_import_policy_json: unknown }>(
      `SELECT ambient_import_policy_json FROM workspace_locations WHERE id = $1`,
      [locationId],
    );
    const parsed = AmbientImportPolicySchema.safeParse(result.rows[0]?.ambient_import_policy_json ?? {});
    return parsed.success ? parsed.data : { entries: [], offered_at: null };
  }

  private async writePolicy(locationId: string, policy: AmbientImportPolicy): Promise<void> {
    await this.db.query(
      `UPDATE workspace_locations SET ambient_import_policy_json = $2::jsonb, updated_at = now() WHERE id = $1`,
      [locationId, JSON.stringify(policy)],
    );
  }

  /** Counts the daemon last observed, for the offer; never content. */
  async counts(identity: SpaceUserIdentity, locationId: string): Promise<AmbientSessionCount[]> {
    await this.requireTarget(identity, locationId);
    const result = await this.db.query<{ ambient_session_counts_json: unknown }>(
      `SELECT ambient_session_counts_json FROM workspace_locations WHERE id = $1`,
      [locationId],
    );
    const raw = result.rows[0]?.ambient_session_counts_json;
    return Array.isArray(raw) ? (raw as AmbientSessionCount[]) : [];
  }

  /**
   * Records the person's answer to the offer.
   *
   * `sync` is standing consent for this folder on this machine, and it is the
   * only thing that lets a later heartbeat import anything: continuous sync
   * without an explicit per-Location policy is a non-goal, because typing in
   * one's own terminal is not an act of publishing to a Project.
   * `default_visibility` is stored with it because the person chose it knowing
   * the consequence — a shared session feeds extraction, a private one never
   * does.
   */
  async setPolicy(
    identity: SpaceUserIdentity,
    locationId: string,
    input: {
      adapter_type: string;
      installation?: string;
      sync: boolean;
      default_visibility?: "private" | "space_shared";
      auto_extract?: boolean;
    },
  ): Promise<AmbientImportPolicy> {
    await this.requireTarget(identity, locationId);
    const policy = await this.readPolicy(locationId);
    const installation = input.installation ?? OWN_INSTALLATION;
    const entry: AmbientImportPolicyEntry = {
      adapter_type: input.adapter_type,
      installation,
      sync: input.sync,
      // Carried forward when the caller only moved the sync switch: silently
      // resetting a session default the person chose is how private history
      // becomes shared without anyone deciding it.
      default_visibility: input.default_visibility
        ?? policy.entries.find((existing) =>
          existing.adapter_type === input.adapter_type && existing.installation === installation)?.default_visibility
        ?? "space_shared",
      auto_extract: input.auto_extract
        ?? policy.entries.find((existing) =>
          existing.adapter_type === input.adapter_type && existing.installation === installation)?.auto_extract
        ?? false,
      updated_at: new Date().toISOString(),
      updated_by_user_id: identity.userId,
    };
    const entries = policy.entries.filter(
      (existing) => !(existing.adapter_type === entry.adapter_type && existing.installation === entry.installation),
    );
    entries.push(entry);
    const next: AmbientImportPolicy = { entries, offered_at: policy.offered_at ?? new Date().toISOString() };
    await this.writePolicy(locationId, next);
    return next;
  }

  /** Marks the offer answered without consenting, so the banner stops asking. */
  async dismissOffer(identity: SpaceUserIdentity, locationId: string): Promise<AmbientImportPolicy> {
    await this.requireTarget(identity, locationId);
    const policy = await this.readPolicy(locationId);
    const next: AmbientImportPolicy = { ...policy, offered_at: policy.offered_at ?? new Date().toISOString() };
    await this.writePolicy(locationId, next);
    return next;
  }

  /**
   * Every imported session in a Project this viewer may read.
   *
   * Gated by the canonical content predicate rather than by host ownership:
   * importing is the owner's act, but a session they shared into the Project
   * is ordinary Project content that a teammate reads like anything else.
   */
  async listForProject(identity: SpaceUserIdentity, projectId: string): Promise<ImportedSessionRow[]> {
    return this.sessions.listForProjectAsViewer(identity, projectId);
  }

  async list(identity: SpaceUserIdentity, locationId: string): Promise<ImportedSessionRow[]> {
    await this.requireTarget(identity, locationId);
    return this.sessions.listForLocation(identity.spaceId, locationId);
  }

  /**
   * Runs one sync for one runtime on one Location.
   *
   * `sessionIds` narrows a first import to what the person selected. A sync
   * with no selection replays everything in the window whose vendor timestamp
   * moved, which is the incremental unit that survives a source being
   * rewritten, forked, or compacted.
   */
  async sync(
    identity: SpaceUserIdentity,
    locationId: string,
    input: {
      adapter_type: string;
      installation?: string;
      session_ids?: string[] | null;
      visibility?: "private" | "space_shared";
      /**
       * Who asked. A scheduled sync is nobody being present, and ADR 0010
       * does not let a person's attended consent stand in for that.
       */
      initiator?: "user" | "schedule";
    },
  ): Promise<AmbientSyncReport> {
    const target = await this.requireTarget(identity, locationId);
    const installation = input.installation ?? OWN_INSTALLATION;
    const report: AmbientSyncReport = {
      location_id: locationId,
      adapter_type: input.adapter_type,
      installation,
      sessions_seen: 0,
      sessions_written: 0,
      records_inserted: 0,
      records_unchanged: 0,
      records_conflicted: 0,
      marked_gone: 0,
      usage_events: 0,
      usage_failures: 0,
      malformed_sessions: 0,
      failed_sessions: 0,
      error: null,
    };
    if (!target.host_online) {
      report.error = "host_offline";
      return report;
    }

    const probe = acpRuntimeProbes().find((candidate) => candidate.adapter_type === input.adapter_type);
    if (!probe) throw new HttpError(422, `Unknown runtime adapter ${input.adapter_type}`);

    const policy = await this.readPolicy(locationId);
    const entry = policy.entries.find(
      (candidate) => candidate.adapter_type === input.adapter_type && candidate.installation === installation,
    );
    const visibility = input.visibility ?? entry?.default_visibility ?? "space_shared";

    const alreadyHeld = await this.sessions.countForRuntime({
      spaceId: identity.spaceId,
      workspaceLocationId: locationId,
      adapterType: input.adapter_type,
      installation,
    });

    const held = await this.sessions.heldSessions({
      spaceId: identity.spaceId,
      workspaceLocationId: locationId,
      adapterType: input.adapter_type,
      installation,
    });

    const retrySessionIds = await this.sessions.unfinishedSessionIds({
      spaceId: identity.spaceId,
      workspaceLocationId: locationId,
      adapterType: input.adapter_type,
      installation,
    });

    const replays: AmbientSessionImport[] = [];
    const result = await sharedHostConnectionRegistry.requestAmbientImport(
      target.host_id,
      {
        workspace_location_id: locationId,
        adapter_type: input.adapter_type,
        installation,
        session_ids: input.session_ids ?? null,
        retry_session_ids: retrySessionIds,
        unchanged: held.filter((entry) => !retrySessionIds.includes(entry.session_id)),
        window_days: AMBIENT_DEFAULT_WINDOW_DAYS,
        max_sessions: AMBIENT_DEFAULT_MAX_SESSIONS,
        limits: AMBIENT_TRIM_LIMITS,
      },
      (session) => {
        // Parsed, not believed: a daemon runs on a machine the person owns,
        // and a malformed session is dropped rather than allowed to fail the
        // whole import — the source may not exist to retry against. The cap
        // is what stops a misbehaving daemon from filling this process's
        // memory with one request.
        if (replays.length >= MAX_SESSIONS_PER_SYNC) return;
        const parsed = AmbientSessionImportSchema.safeParse(session);
        if (parsed.success) replays.push(parsed.data);
        else report.malformed_sessions += 1;
      },
    );

    for (const replay of replays) {
      report.sessions_seen += 1;
      try {
      // One short transaction per session: the ACP round trip is already done,
      // so nothing slow is held open, and a session either lands whole or not
      // at all rather than leaving a row whose record count disagrees with its
      // records (DATABASE_AND_TRANSACTIONS).
      const outcome = await withQueryableTransaction(this.db, (tx) => new PgImportedSessionRepository(tx).reconcile({
        spaceId: identity.spaceId,
        projectId: target.project_id,
        projectFolderId: target.project_folder_id,
        workspaceLocationId: locationId,
        executionHostId: target.host_id,
        ownerUserId: identity.userId,
        adapterType: input.adapter_type,
        installation,
        visibility,
        session: replay.session,
        loadState: replay.load_state,
        error: replay.error,
        records: replay.records,
      }));
      report.sessions_written += 1;
      report.records_inserted += outcome.inserted;
      report.records_unchanged += outcome.unchanged;
      report.records_conflicted += outcome.conflicted;
      const usage = await this.forwardUsage(target, outcome.session, replay);
      report.usage_events += usage.written;
      report.usage_failures += usage.failed;
      } catch (error) {
        // Each session is its own transaction, so one that cannot be written
        // has committed nothing — and must not discard the twelve that did,
        // nor the `gone` reconciliation and the record of the sync below.
        report.failed_sessions += 1;
        report.error ??= error instanceof HttpError ? error.message : "a session could not be written";
      }
    }

    report.error = result.ok ? report.error : result.error;
    // Decided from what the host actually enumerated, never from what this
    // server happens to hold: the server's own set always contains the
    // sessions in question, so using it would mean nothing is ever gone.
    // Only a successful full enumeration is evidence — a failed one, or a
    // request narrowed to named sessions, says nothing about the rest.
    if (result.ok && !input.session_ids && result.listed_session_ids) {
      report.marked_gone = await this.sessions.markMissingAsGone({
        spaceId: identity.spaceId,
        workspaceLocationId: locationId,
        adapterType: input.adapter_type,
        installation,
        listedVendorSessionIds: result.listed_session_ids,
      });
    }
    // Written even when the import ended in an error: a sync that wrote
    // sessions and then failed is exactly the one worth a record.
    await this.writeBatchPointer(identity, target, report);
    await this.maybeExtract(identity, target, entry, report, {
      firstImport: alreadyHeld === 0,
      initiator: input.initiator ?? "user",
    });
    return report;
  }

  /**
   * Extracts, when the person has either just asked for their first import or
   * has said extraction may run on its own.
   *
   * The first import is the one case where waiting would be wrong: a person
   * who has just imported a folder's history and is shown a list of raw
   * records has been given nothing they can act on. Every sync after that is
   * silent unless they turned the switch on, because extraction spends model
   * budget and a background spend nobody asked for is not a small thing.
   *
   * Failure is swallowed on purpose: the import succeeded, and an extraction
   * that could not run is something the person can retry from the button.
   */
  private async maybeExtract(
    identity: SpaceUserIdentity,
    target: DispatchTarget,
    entry: AmbientImportPolicyEntry | undefined,
    report: AmbientSyncReport,
    context: { firstImport: boolean; initiator: "user" | "schedule" },
  ): Promise<void> {
    if (report.records_inserted === 0) return;
    // Two separate permissions, and neither substitutes for the other.
    //
    // A person who just imported a folder and is shown a list of raw records
    // has been given nothing to act on, so their *own* first import extracts
    // once. "First" means this Location held no history for this runtime
    // before the sync, not that no policy exists — someone who never touched
    // the sync switch has no entry either, and reading that as first would
    // extract on every import they ever run.
    //
    // A scheduled sync is nobody being present. It extracts only where the
    // person said extraction may run on its own, because the budget it spends
    // may be a managed subscription and unattended spending is not implied by
    // attended spending (ADR 0010).
    const attendedFirstImport = context.firstImport && context.initiator === "user";
    if (!attendedFirstImport && entry?.auto_extract !== true) return;
    try {
      const { ImportedHistoryExtractionService } = await import("./extraction.js");
      await new ImportedHistoryExtractionService(this.db, this.config)
        .extract(identity, target.project_id, target.location_id);
    } catch {
      // The import stands; the button remains.
    }
  }

  /**
   * Forwards a replay's token usage to the canonical ledger.
   *
   * This is the person's own subscription spend on their own machine, which
   * Rainver never saw at the time. It is attributed to the host owner and
   * marked `ambient_host_history` so it can never be confused with a Run this
   * control plane dispatched; the idempotency key is derived from the record
   * identity, so re-syncing the same session does not count it twice.
   */
  private async forwardUsage(
    target: DispatchTarget,
    session: ImportedSessionRow,
    replay: AmbientSessionImport,
  ): Promise<{ written: number; failed: number }> {
    let written = 0;
    let failed = 0;
    for (const usage of replay.usage) {
      const observation = {
        space_id: target.space_id,
        event_type: "cli.history_usage" as const,
        source_type: "ambient_host_history" as const,
        source_resource_type: "imported_session",
        source_resource_id: session.id,
        execution_channel: "local_cli" as const,
        meter_subject_type: "user",
        meter_subject_id: session.owner_user_id,
        subject_user_id: session.owner_user_id,
        adapter_type: session.adapter_type,
        model: usage.model,
        project_id: target.project_id,
        project_folder_id: target.project_folder_id,
        external_session_id: session.vendor_session_id,
        occurred_at: usage.occurred_at ?? session.vendor_updated_at ?? null,
        usage_accuracy: "provider_reported" as const,
        usage_details: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          input_cache_read: usage.cache_read_input_tokens ?? 0,
          input_cache_creation: usage.cache_creation_input_tokens ?? 0,
          output_reasoning: usage.reasoning_tokens ?? 0,
        },
        // Keyed on what the event *is*, not on where it sat in the replay:
        // a compacted session drops earlier events and shifts every later
        // one, so a positional key would silently re-point at a different
        // event and the ledger would under-count.
        idempotency_key: `ambient:${session.id}:${usageFingerprint(usage)}`,
      };
      try {
        const attribution = await resolveUsageObservationAttribution(this.config, observation);
        await recordAttributedUsageObservation(this.config, observation, attribution);
        written += 1;
      } catch {
        // Usage is a byproduct of the import, not its purpose: a ledger that
        // rejects one event must not cost the conversation it came with. It is
        // counted, though — a silently short total is indistinguishable from
        // a machine that simply reported no usage.
        failed += 1;
      }
    }
    return { written, failed };
  }

  /**
   * One Activity row per sync, as a pointer.
   *
   * B24A: the Inbox holds pointers, never content. The records live in this
   * module's own tables and are read on the Project's own surface; this row
   * exists so an import is visible as something that happened.
   *
   * Written through the activity module's own repository rather than by
   * reaching into its table: that module owns the trust, status and column
   * rules for an `external_chat` record (B12), and a second writer would
   * duplicate them and then drift.
   */
  private async writeBatchPointer(
    identity: SpaceUserIdentity,
    target: DispatchTarget,
    report: AmbientSyncReport,
  ): Promise<void> {
    if (report.sessions_written === 0 && report.marked_gone === 0) return;
    const label = `Imported ${report.sessions_written} ${report.adapter_type} session${report.sessions_written === 1 ? "" : "s"}`;
    try {
      await new PgActivityRepository(this.db).create(identity, {
        source_type: "external_chat",
        project_id: target.project_id,
        project_folder_id: target.project_folder_id,
        title: label,
        content: label,
        visibility: "space_shared",
        metadata_json: report as unknown as Record<string, unknown>,
      });
    } catch {
      // The pointer is a notification, not the import. A Project whose
      // membership blocks this row must still keep the sessions it just
      // imported.
    }
  }

  async records(identity: SpaceUserIdentity, sessionId: string) {
    // `full`, not merely "not denied": the gate also grants `summary`, which
    // an oversight-mode Space gives an admin over a colleague's private
    // content. A transcript is the content itself, so summary access must not
    // open it — the same rule Reader and Sources apply.
    const decision = await contentDecisionFromDb(this.db, identity, "imported_session", sessionId);
    if (decision !== "full") throw new HttpError(404, "Imported session not found");
    const session = await this.sessions.byId(identity.spaceId, sessionId);
    if (!session) throw new HttpError(404, "Imported session not found");
    const page = await this.sessions.records(identity.spaceId, sessionId);
    return { session, records: page.records, truncated: page.truncated };
  }

  /**
   * Whether this person may administer an imported session.
   *
   * Its owner always may, and that is the path that still works once the
   * Location has been unregistered — the session belongs to the Project, so
   * losing the checkout it came from must not strand it beyond reach. While
   * the Location does exist, the host-owner and Project-writer checks apply
   * as they do for importing.
   */
  private async requireSessionAuthority(
    identity: SpaceUserIdentity,
    session: ImportedSessionRow,
  ): Promise<void> {
    if (session.owner_user_id === identity.userId) return;
    if (!session.workspace_location_id) {
      throw new HttpError(403, "Only the person who imported this session can change it");
    }
    await this.requireTarget(identity, session.workspace_location_id);
  }

  async setVisibility(
    identity: SpaceUserIdentity,
    sessionId: string,
    visibility: "private" | "space_shared",
  ): Promise<ImportedSessionRow> {
    const session = await this.sessions.byId(identity.spaceId, sessionId);
    if (!session) throw new HttpError(404, "Imported session not found");
    await this.requireSessionAuthority(identity, session);
    const updated = await this.sessions.setVisibility(identity.spaceId, sessionId, visibility);
    return updated!;
  }

  /**
   * Deletes imported sessions permanently.
   *
   * The caller is expected to have shown what this costs: the host's own copy
   * may already be gone, so this can be the only copy that exists, and
   * anything extracted from these records keeps its text while its citations
   * stop resolving.
   */
  async remove(identity: SpaceUserIdentity, sessionIds: readonly string[]): Promise<number> {
    const deletable: string[] = [];
    for (const id of sessionIds) {
      const session = await this.sessions.byId(identity.spaceId, id);
      if (!session) continue;
      await this.requireSessionAuthority(identity, session);
      deletable.push(id);
    }
    return this.sessions.deleteSessions(identity.spaceId, deletable);
  }
}
