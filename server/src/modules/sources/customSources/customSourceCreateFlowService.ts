import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  CustomSourceHandlerInput,
  CustomSourcePolicyEnvelope,
} from "@agent-space/protocol";
import type { ServerConfig } from "../../../config.js";
import {
  HttpError,
  objectValue,
  optionalString,
  requiredString,
  withDbTransaction,
  type Pool,
  type Queryable,
  type SpaceUserIdentity,
} from "../../routeUtils/common.js";
import { SourceChannelService } from "../channels/sourceChannelService.js";
import {
  HANDLER_RUN_COLUMNS,
  HANDLER_VERSION_COLUMNS,
  PgCustomSourceHandlerRepository,
  handlerRunOut,
  handlerVersionOut,
  type HandlerRunRow,
  type HandlerVersionRow,
} from "./customSourceHandlerRepository.js";
import { sha256 } from "../sourceRepositoryMappers.js";
import { cleanupSandbox, effectiveCustomSourceLimits, evaluateCustomSourceRunnerBlockReason } from "./customSourceRunner.js";
import { fetchCustomSourceEndpointHtml } from "./customSourceEndpointFetch.js";
import { executeCustomSourceHandler } from "./customSourceHandlerExecution.js";
import { validateCustomSourceHandlerOutput } from "./customSourceContractValidator.js";
import {
  CUSTOM_SOURCE_HANDLER_ENTRYPOINT,
  generateCustomSourceHandlerSource,
} from "./customSourceHandlerTemplate.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import { getSourceChannelScanTask, upsertSourceChannelScanTask } from "../sourceConnectionScheduler.js";
import { resolveRequestedSourceSchedule } from "../sourceScheduleInput.js";
import { CUSTOM_SOURCE_PIPELINE_HANDLER_ENTRYPOINT } from "./customSourcePipelineInterpreter.js";
import { CustomSourceCredentialService } from "./customSourceCredentialService.js";
import {
  parseSourceCapturePolicy,
  parseSourceRetentionPolicy,
  SOURCE_CAPTURE_POLICY_RANK,
  type SourceCapturePolicy,
  type SourceRetentionPolicy,
} from "../capturePolicy.js";

/**
 * Phase 5 create-flow: draft -> generate -> test -> activate. Owns every
 * write to `source_handler_versions` and the `source_connections` handler
 * pointers; `customSourceHandlerRepository.ts` stays a read model.
 *
 * Policy-delta activation creates a real `custom_source_*` proposal and binds
 * the tested handler version to it as `pending_approval`; accepting the
 * proposal dispatches through the Custom Source proposal applier.
 */
export class CustomSourceCreateFlowService {
  constructor(
    private readonly pool: Pool,
    private readonly config: ServerConfig,
  ) {}

  async createDraft(identity: SpaceUserIdentity, body: Record<string, unknown>) {
    if (Object.hasOwn(body, "credential_ref") && body.credential_ref != null) {
      throw new HttpError(422, "credential_ref is not accepted directly — create a Custom Source credential first and reference it by credential_id");
    }
    const credentialId = optionalString(body.credential_id);
    const endpointUrl = requiredString(body.endpoint_url, "endpoint_url");
    const hostname = parseHostname(endpointUrl);

    const settingsRepo = new PgCustomSourceHandlerRepository(this.pool, this.config);
    const settings = await settingsRepo.getEffectiveSettings(identity);
    await settingsRepo.requireCustomSourceCreator(identity, settings.space.creator_roles);
    if (settings.space.allowed_domains.length > 0 && !domainAllowed(hostname, settings.space.allowed_domains)) {
      throw new HttpError(422, `Domain not allowed by Space Custom Source policy: ${hostname}`);
    }
    if (credentialId) {
      await new CustomSourceCredentialService(this.pool, this.config).requireOwnCredential(identity, credentialId);
    }

    const config = objectValue(body.config);
    return withDbTransaction(this.pool, async (client) => {
      const channel = await new SourceChannelService(client, this.config).create(identity, {
        project_id: optionalString(body.project_id),
        visibility: optionalString(body.visibility),
        provider_key: "custom_source",
        name: requiredString(body.name, "name"),
        endpoint_url: endpointUrl,
        credential_id: credentialId,
        fetch_frequency: optionalString(body.fetch_frequency) ?? "manual",
        next_check_at: body.next_check_at,
        schedule_rule: body.schedule_rule,
        capture_policy: optionalString(config.capture_policy) ?? settings.space.default_capture_policy,
        policy: { retention_policy: optionalString(config.retention_policy) ?? settings.space.default_retention_policy },
        status: "paused",
        query: { config },
        config,
      });
      const now = new Date().toISOString();
      await client.query(
        `UPDATE source_connections
            SET handler_kind = 'generated_custom', status = 'paused', updated_at = $3
          WHERE id = $1 AND space_id = $2
          RETURNING id`,
        [channel.source_connection_id, identity.spaceId, now],
      );
      // Custom Source lifecycle methods and routes are keyed by the underlying
      // connection. Preserve the channel id explicitly for channel-scoped
      // reads while making the public `id` unambiguous for this API.
      return {
        ...channel,
        id: channel.source_connection_id,
        source_channel_id: channel.id,
        handler_kind: "generated_custom",
        status: "paused",
      };
    });
  }

  async generateHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireCustomSourceConnection(identity, connectionId);
    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getEffectiveSettings(identity);
    const config = objectValue(connection.config_json);
    const endpointOrigin = parseOrigin(connection.endpoint_url ?? "");

    const capturePolicy = requireCapturePolicy(optionalString(body.capture_policy) ?? connection.capture_policy);
    const retentionPolicy = requireRetentionPolicy(
      optionalString(body.retention_policy) ??
      optionalString((connection.policy_json as Record<string, unknown> | null)?.retention_policy) ??
      settings.space.default_retention_policy,
    );

    const generationMode = optionalString(body.generation_mode) ?? "code_template";
    if (generationMode !== "code_template" && generationMode !== "pipeline") {
      throw new HttpError(422, `Unsupported generation_mode: ${generationMode}`);
    }

    const baseLimits = {
      timeout_ms: Math.min(30_000, settings.runner.timeout_ms_max),
      max_download_bytes: settings.runner.download_bytes_max,
      max_output_bytes: Math.min(1_048_576, settings.runner.output_bytes_max),
      max_files: Math.min(10, settings.runner.max_files),
      max_evidence_items: 50,
      log_max_bytes: Math.min(65_536, settings.runner.log_bytes_max),
    };

    if (generationMode === "pipeline") {
      const parsedPipeline = protocol.CustomSourcePipelineDefinitionSchema.safeParse(body.pipeline);
      if (!parsedPipeline.success) {
        throw new HttpError(422, "generation_mode 'pipeline' requires a valid pipeline definition in body.pipeline");
      }
      const pipeline = parsedPipeline.data;
      const policyEnvelope: CustomSourcePolicyEnvelope = {
        allowed_network_origins: [endpointOrigin],
        capture_policy: capturePolicy,
        retention_policy: retentionPolicy,
        credential_ref: connection.credential_id,
        language: "declarative_pipeline_v1",
        browser_automation_enabled: false,
        shell_enabled: false,
        dependency_installation_enabled: false,
        log_redaction_enabled: true,
        limits: { ...baseLimits, max_items: 50 },
      };
      const checksum = sha256(JSON.stringify(pipeline));
      const version = await this.withGenerateRateLimit(identity, connectionId, (client) =>
        this.insertHandlerVersionRow(client, {
          spaceId: identity.spaceId,
          connectionId,
          entrypoint: CUSTOM_SOURCE_PIPELINE_HANDLER_ENTRYPOINT,
          handlerArtifactId: null,
          manifest: { generator: "pipeline_v1", pipeline },
          policyEnvelope,
          checksum,
          createdByUserId: identity.userId,
        }),
      );
      return handlerVersionOut(version);
    }

    // body.list_selector lets a caller override the connection's stored
    // config without editing it first — repair uses this to carry forward
    // the active version's manifest value (or an explicit fixed selector)
    // when regenerating.
    const listSelector = optionalString(body.list_selector) ?? optionalString(config.list_selector);
    const policyEnvelope: CustomSourcePolicyEnvelope = {
      allowed_network_origins: [endpointOrigin],
      capture_policy: capturePolicy,
      retention_policy: retentionPolicy,
      credential_ref: connection.credential_id,
      language: "typescript_node",
      browser_automation_enabled: false,
      shell_enabled: false,
      dependency_installation_enabled: false,
      log_redaction_enabled: true,
      limits: { ...baseLimits, max_items: listSelector ? 50 : 1 },
    };

    const source = generateCustomSourceHandlerSource({ listSelector });
    const checksum = sha256(source);

    const version = await this.withGenerateRateLimit(identity, connectionId, async (client) => {
      const artifactId = await this.storeHandlerSourceArtifact(client, identity.spaceId, connectionId, source);
      return this.insertHandlerVersionRow(client, {
        spaceId: identity.spaceId,
        connectionId,
        entrypoint: CUSTOM_SOURCE_HANDLER_ENTRYPOINT,
        handlerArtifactId: artifactId,
        manifest: { generator: "template_v1", list_selector: listSelector },
        policyEnvelope,
        checksum,
        createdByUserId: identity.userId,
      });
    });
    return handlerVersionOut(version);
  }

  async testHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    const connection = await this.requireCustomSourceConnection(identity, connectionId);
    const versionId = requiredString(body.handler_version_id, "handler_version_id");
    const version = await this.requireHandlerVersion(identity, connectionId, versionId);
    if (version.status !== "draft" && version.status !== "test_failed") {
      throw new HttpError(409, `Handler version must be draft or test_failed to test (was ${version.status})`);
    }

    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getEffectiveSettings(identity);
    const policyEnvelope = envelopeOf(version);
    const blockReason = evaluateCustomSourceRunnerBlockReason(settings.runner, policyEnvelope);
    const credential = await new CustomSourceCredentialService(this.pool, this.config).resolveCredentialHeader(
      identity.spaceId,
      policyEnvelope.credential_ref,
    );
    const fixtureHtml = optionalString(body.fixture_html);
    const fetchedHtml =
      fixtureHtml ??
      (blockReason ? "" : await fetchCustomSourceEndpointHtml(connection.endpoint_url, settings.runner, policyEnvelope, credential));

    const runId = randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO source_handler_runs (
         id, space_id, source_connection_id, handler_version_id, status, created_at, started_at
       ) VALUES ($1, $2, $3, $4, 'running', $5, $5)`,
      [runId, identity.spaceId, connectionId, versionId, now],
    );

    let runnerResult;
    if (blockReason) {
      runnerResult = { status: "blocked", reason: blockReason } as const;
    } else {
      try {
        runnerResult = await executeCustomSourceHandler(this.pool, this.config, settings.runner, {
          version,
          policyEnvelope,
          credential,
          handlerInput: buildHandlerInput({
            mode: "test",
            jobId: runId,
            connectionId: connection.id,
            endpointUrl: connection.endpoint_url,
            versionId: version.id,
            policyEnvelope,
            fetchedHtml,
          }),
        });
      } catch (error) {
        // Without this catch, a dispatcher-level failure (e.g. a stored
        // pipeline definition that no longer passes schema validation, or a
        // missing source artifact) would propagate uncaught and leave the
        // `source_handler_runs` row stuck in 'running' forever — see the
        // pipeline-model review that found this gap.
        return this.recordTestOutcome(identity, connectionId, versionId, runId, {
          status: "failed",
          failure_class: "handler_execution_error",
          test_result: {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (runnerResult.status === "blocked") {
      return this.recordTestOutcome(identity, connectionId, versionId, runId, {
        status: "blocked",
        failure_class: runnerResult.reason,
        test_result: { status: "blocked", reason: runnerResult.reason },
      });
    }

    try {
      if (runnerResult.exit_code !== 0 || runnerResult.raw_output_json === null) {
        return await this.recordTestOutcome(identity, connectionId, versionId, runId, {
          status: "failed",
          failure_class: runnerResult.timed_out
            ? "timeout"
            : runnerResult.output_too_large
              ? "output_too_large"
              : "nonzero_exit",
          test_result: {
            status: "failed",
            exit_code: runnerResult.exit_code,
            timed_out: runnerResult.timed_out,
            output_too_large: runnerResult.output_too_large,
            logs: runnerResult.logs,
          },
        });
      }

      // Validation must run against the sandbox files/ directory before it is
      // cleaned up (declared snapshot paths are checked against disk) — see
      // the `finally` block below, mirroring CustomSourceMaterializationService's
      // validate-before-cleanup ordering.
      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(runnerResult.raw_output_json);
      } catch (error) {
        return await this.recordTestOutcome(identity, connectionId, versionId, runId, {
          status: "failed",
          failure_class: "invalid_output_json",
          test_result: {
            status: "failed",
            reason: error instanceof Error ? error.message : "Handler output was not valid JSON",
          },
        });
      }

      const validation = await validateCustomSourceHandlerOutput({
        raw: parsedOutput,
        limits: effectiveCustomSourceLimits(settings.runner, policyEnvelope.limits),
        allowedNetworkOrigins: policyEnvelope.allowed_network_origins,
        sandboxFilesRoot: runnerResult.sandbox_files_root,
      });

      if (!validation.ok) {
        return await this.recordTestOutcome(identity, connectionId, versionId, runId, {
          status: "validation_failed",
          failure_class: "contract_validation_failed",
          test_result: { status: "validation_failed", errors: validation.errors },
        });
      }

      return await this.recordTestOutcome(identity, connectionId, versionId, runId, {
        status: "succeeded",
        failure_class: null,
        test_result: {
          status: "succeeded",
          item_count: validation.output.items.length,
          warnings: validation.output.diagnostics.warnings,
          preview_items: validation.output.items.slice(0, 5),
        },
      });
    } finally {
      await cleanupSandbox(runnerResult.sandbox_files_root).catch(() => undefined);
    }
  }

  async activateHandler(identity: SpaceUserIdentity, connectionId: string, body: Record<string, unknown>) {
    await this.requireCustomSourceConnection(identity, connectionId);
    const versionId = requiredString(body.handler_version_id, "handler_version_id");
    const version = await this.requireHandlerVersion(identity, connectionId, versionId);

    if (version.status !== "draft") {
      throw new HttpError(409, `Handler version must be in draft status to activate (was ${version.status})`);
    }
    const testResult = version.test_result_json as { status?: string } | null;
    if (testResult?.status !== "succeeded") {
      throw new HttpError(409, "Handler version must pass a fixture test before activation");
    }

    const settings = await new PgCustomSourceHandlerRepository(this.pool, this.config).getEffectiveSettings(identity);
    const activePointer = await this.pool.query<{ active_handler_version_id: string | null; fetch_frequency: string }>(
      `SELECT sc.active_handler_version_id, ch.fetch_frequency
         FROM source_connections sc
         JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
        WHERE sc.space_id = $1 AND sc.id = $2
        ORDER BY ch.updated_at DESC LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    const activeVersionId = activePointer.rows[0]?.active_handler_version_id ?? null;
    const activeVersionRow = activeVersionId
      ? await this.pool.query<HandlerVersionRow>(
          `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions WHERE space_id = $1 AND id = $2`,
          [identity.spaceId, activeVersionId],
        )
      : null;
    const activeEnvelope = activeVersionRow?.rows[0] ? envelopeOf(activeVersionRow.rows[0]) : null;

    const evaluation = evaluateCustomSourceActivation(envelopeOf(version), {
      activeEnvelope,
      spaceAllowedDomains: settings.space.allowed_domains,
      credentialedSourcesAllowed: settings.space.credentialed_sources_allowed,
      spaceDefaultCapturePolicy: settings.space.default_capture_policy,
      spaceDefaultRetentionPolicy: settings.space.default_retention_policy,
    });

    if (!evaluation.withinEnvelope) {
      const proposalType = customSourceProposalTypeForEnvelope(envelopeOf(version), {
        credentialedSourcesAllowed: settings.space.credentialed_sources_allowed,
      });
      const payload = customSourceProposalPayload({
        proposalType,
        connectionId,
        handlerVersionId: versionId,
        currentHandlerVersionId: activeVersionId,
        currentEnvelope: activeEnvelope,
        proposedEnvelope: envelopeOf(version),
        deltas: evaluation.deltas,
        requestedByUserId: identity.userId,
        nextCheckAt: body.next_check_at,
        scheduleRule: body.schedule_rule,
      });
      const reviewText = customSourceProposalReviewText({
        proposalType,
        connectionId,
        handlerVersionId: versionId,
        activeHandlerVersionId: activeVersionId,
        deltas: evaluation.deltas,
        proposedEnvelope: envelopeOf(version),
      });
      const created = await withDbTransaction(this.pool, async (client) => {
        const proposal = await insertProposalRow(client, {
          spaceId: identity.spaceId,
          proposalType,
          title: "Approve Custom Source handler activation",
          summary: reviewText.summary,
          payload: { ...payload, proposed_content: reviewText.proposedContent },
          rationale:
            "Activating this generated Custom Source handler would broaden the approved policy envelope.",
          createdByUserId: identity.userId,
          visibility: "space_shared",
          riskLevel: customSourceProposalRisk(proposalType),
          requiredApproverRole: "owner",
        });
        const updatedVersion = await client.query<HandlerVersionRow>(
          `UPDATE source_handler_versions
              SET status = 'pending_approval', proposal_id = $3
            WHERE id = $1
              AND space_id = $2
              AND status = 'draft'
            RETURNING ${HANDLER_VERSION_COLUMNS}`,
          [versionId, identity.spaceId, proposal.id],
        );
        const row = updatedVersion.rows[0];
        if (!row) {
          throw new HttpError(409, "Handler version is no longer eligible for activation approval");
        }
        return { proposal, version: row };
      });
      return {
        status: "pending_approval" as const,
        deltas: evaluation.deltas,
        proposal_id: created.proposal.id,
        handler_version: handlerVersionOut(created.version),
      };
    }

    await activateCustomSourceHandlerVersion(
      this.pool,
      identity,
      connectionId,
      versionId,
      activeVersionId,
      body.next_check_at,
      body.schedule_rule,
    );
    const activated = await new PgCustomSourceHandlerRepository(this.pool, this.config).getHandlerVersion(
      identity,
      connectionId,
      versionId,
    );
    if (!activated) throw new HttpError(500, "Handler version disappeared immediately after activation");

    return {
      status: "active" as const,
      deltas: [],
      proposal_id: null,
      handler_version: activated,
    };
  }

  // --- internals ---

  /**
   * Phase 12 hardening: bounds how often one connection can trigger a real
   * handler generation (a validation pass, an artifact write, and — for
   * repair — a fixture test run against the live/fixture endpoint). Repair
   * goes through this same check since it calls `generateHandler`
   * internally; there is no separate limit to keep in sync.
   */
  private async withGenerateRateLimit<T>(
    identity: SpaceUserIdentity,
    connectionId: string,
    fn: (client: Queryable) => Promise<T>,
  ): Promise<T> {
    return withDbTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `custom_source_generate:${identity.spaceId}:${connectionId}`,
      ]);
      await this.enforceGenerateRateLimit(client, identity, connectionId);
      return fn(client);
    });
  }

  private async enforceGenerateRateLimit(
    db: Queryable,
    identity: SpaceUserIdentity,
    connectionId: string,
  ): Promise<void> {
    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2 AND created_at >= $3`,
      [identity.spaceId, connectionId, windowStart],
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (count >= this.config.customSourceGenerateRateLimitPerHour) {
      throw new HttpError(
        429,
        `Custom Source handler generation rate limit exceeded (${this.config.customSourceGenerateRateLimitPerHour}/hour per connection)`,
      );
    }
  }

  private async requireCustomSourceConnection(identity: SpaceUserIdentity, connectionId: string) {
    const result = await this.pool.query<{
      id: string;
      endpoint_url: string | null;
      capture_policy: string;
      config_json: unknown;
      policy_json: unknown;
      handler_kind: string;
      credential_id: string | null;
    }>(
      `SELECT sc.id, ch.endpoint_url, sc.capture_policy, sc.config_json, sc.policy_json, sc.handler_kind, sc.credential_id
         FROM source_connections sc
         JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
        WHERE sc.space_id = $1 AND sc.id = $2 AND sc.deleted_at IS NULL
        ORDER BY ch.updated_at DESC LIMIT 1`,
      [identity.spaceId, connectionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Source connection not found");
    if (row.handler_kind !== "generated_custom") {
      throw new HttpError(422, "Source connection is not a Custom Source");
    }
    return row;
  }

  private async requireHandlerVersion(
    identity: SpaceUserIdentity,
    connectionId: string,
    versionId: string,
  ): Promise<HandlerVersionRow> {
    const result = await this.pool.query<HandlerVersionRow>(
      `SELECT ${HANDLER_VERSION_COLUMNS} FROM source_handler_versions
        WHERE space_id = $1 AND source_connection_id = $2 AND id = $3`,
      [identity.spaceId, connectionId, versionId],
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, "Handler version not found");
    return row;
  }

  private async insertHandlerVersionRow(
    db: Queryable,
    input: {
      spaceId: string;
      connectionId: string;
      entrypoint: string;
      handlerArtifactId: string | null;
      manifest: Record<string, unknown>;
      policyEnvelope: CustomSourcePolicyEnvelope;
      checksum: string;
      createdByUserId: string;
    },
  ): Promise<HandlerVersionRow> {
    const now = new Date().toISOString();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await db.query<HandlerVersionRow>(
          `INSERT INTO source_handler_versions (
             id, space_id, source_connection_id, version_number, language, entrypoint,
             handler_artifact_id, manifest_json, policy_envelope_json, checksum, status,
             created_by_user_id, created_at
           )
           SELECT $1, $2, $3, COALESCE(MAX(version_number), 0) + 1, $4, $5,
                  $6, $7::jsonb, $8::jsonb, $9, 'draft',
                  $10, $11
             FROM source_handler_versions WHERE space_id = $2::character varying AND source_connection_id = $3::character varying
           RETURNING ${HANDLER_VERSION_COLUMNS}`,
          [
            randomUUID(),
            input.spaceId,
            input.connectionId,
            input.policyEnvelope.language,
            input.entrypoint,
            input.handlerArtifactId,
            JSON.stringify(input.manifest),
            JSON.stringify(input.policyEnvelope),
            input.checksum,
            input.createdByUserId,
            now,
          ],
        );
        return result.rows[0]!;
      } catch (error) {
        if (isUniqueViolation(error) && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error("unreachable: version_number insert retry exhausted");
  }

  private async recordTestOutcome(
    identity: SpaceUserIdentity,
    connectionId: string,
    versionId: string,
    runId: string,
    input: { status: string; failure_class: string | null; test_result: Record<string, unknown> },
  ) {
    const now = new Date().toISOString();
    const runResult = await this.pool.query<HandlerRunRow>(
      `UPDATE source_handler_runs
          SET status = $3, failure_class = $4, completed_at = $5
        WHERE id = $1 AND space_id = $2
        RETURNING ${HANDLER_RUN_COLUMNS}`,
      [runId, identity.spaceId, input.status, input.failure_class, now],
    );
    const nextVersionStatus = input.status === "succeeded" ? "draft" : "test_failed";
    const versionResult = await this.pool.query<HandlerVersionRow>(
      `UPDATE source_handler_versions
          SET status = $3, test_result_json = $4::jsonb
        WHERE id = $1 AND space_id = $2
          AND status IN ('draft', 'test_failed')
        RETURNING ${HANDLER_VERSION_COLUMNS}`,
      [versionId, identity.spaceId, nextVersionStatus, JSON.stringify(input.test_result)],
    );
    if (!versionResult.rows[0]) {
      throw new HttpError(409, "Handler version is no longer testable");
    }
    return {
      run: handlerRunOut(runResult.rows[0]!),
      version: handlerVersionOut(versionResult.rows[0]!),
      test_result: input.test_result,
    };
  }

  private async storeHandlerSourceArtifact(
    db: Queryable,
    spaceId: string,
    connectionId: string,
    source: string,
  ): Promise<string> {
    const artifactId = randomUUID();
    const relativePath = join(spaceId, "custom-source", `${artifactId}.handler.cjs`);
    const absolutePath = resolve(this.config.artifactStorageRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, source, "utf8");
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO artifacts (
         id, space_id, artifact_type, title, content, storage_path, mime_type,
         exportable, export_formats_json, canonical_format, preview,
         created_at, updated_at, visibility, trust_level
       ) VALUES (
         $1, $2, 'source_custom_source_handler_code', $3, NULL, $4, 'application/javascript',
         true, $5::jsonb, 'javascript', false,
         $6, $6, 'space_shared', 'low'
       )`,
      [
        artifactId,
        spaceId,
        `Custom Source handler code (connection ${connectionId})`,
        relativePath,
        JSON.stringify(["javascript"]),
        now,
      ],
    );
    return artifactId;
  }

}

function buildHandlerInput(input: {
  mode: "test" | "scan";
  jobId: string;
  connectionId: string;
  endpointUrl: string | null;
  versionId: string;
  policyEnvelope: CustomSourcePolicyEnvelope;
  fetchedHtml: string;
}): CustomSourceHandlerInput {
  return {
    contract_version: "custom_source.handler_input.v1",
    run: {
      mode: input.mode,
      job_id: input.jobId,
      connection_id: input.connectionId,
      handler_version_id: input.versionId,
      started_at: new Date().toISOString(),
    },
    source: {
      name: input.connectionId,
      endpoint_url: input.endpointUrl,
      config: { fetched_html: input.fetchedHtml },
      cursor: null,
    },
    policy: {
      allowed_network_origins: input.policyEnvelope.allowed_network_origins,
      capture_policy: input.policyEnvelope.capture_policy,
      retention_policy: input.policyEnvelope.retention_policy,
      credential_ref: input.policyEnvelope.credential_ref ?? null,
      limits: input.policyEnvelope.limits,
    },
  };
}

function envelopeOf(version: HandlerVersionRow): CustomSourcePolicyEnvelope {
  return version.policy_envelope_json as CustomSourcePolicyEnvelope;
}

/**
 * Supersedes `previousActiveVersionId` (if any), activates `versionId`, and
 * flips the connection's active pointer/status/schedule — the same DB writes
 * `activateHandler`'s inside-envelope branch and repair's auto-activate
 * branch both need. Returns the timestamp used for `activated_at`/
 * `superseded_at` so callers needing to display it don't have to re-query.
 */
export async function activateCustomSourceHandlerVersion(
  pool: Pool,
  identity: SpaceUserIdentity,
  connectionId: string,
  versionId: string,
  previousActiveVersionId: string | null,
  nextCheckAt?: unknown,
  scheduleRule?: unknown,
): Promise<string> {
  const now = new Date().toISOString();
  await withDbTransaction(pool, async (client) => {
    const channelResult = await client.query<{ id: string; space_id: string; owner_user_id: string; fetch_frequency: string; schedule_rule_json: unknown }>(
      `SELECT ch.id, ch.space_id, sc.owner_user_id, ch.fetch_frequency, ch.schedule_rule_json
         FROM source_channels ch
         JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE ch.source_connection_id = $1 AND ch.space_id = $2 AND ch.status <> 'archived'
        ORDER BY ch.updated_at DESC LIMIT 1
        FOR UPDATE OF ch`,
      [connectionId, identity.spaceId],
    );
    const channel = channelResult.rows[0];
    const existingScheduleTask = channel ? await getSourceChannelScanTask(client, channel.id) : null;
    const currentConnection = await client.query<{
      id: string;
      space_id: string;
      owner_user_id: string;
      fetch_frequency: string;
      schedule_rule_json: unknown;
    }>(
      `SELECT id, space_id, owner_user_id
         FROM source_connections
        WHERE id = $1 AND space_id = $2
        FOR UPDATE`,
      [connectionId, identity.spaceId],
    );
    const current = currentConnection.rows[0];
    const schedule = current
      ? resolveRequestedSourceSchedule({
          body: { next_check_at: nextCheckAt, schedule_rule: scheduleRule },
          status: "active",
          fetchFrequency: channel?.fetch_frequency ?? "manual",
          existingNextCheckAt: existingScheduleTask?.next_run_at,
          existingScheduleRule: channel?.schedule_rule_json,
        })
      : null;
    if (previousActiveVersionId) {
      await client.query(
        `UPDATE source_handler_versions SET status = 'superseded', superseded_at = $3 WHERE id = $1 AND space_id = $2`,
        [previousActiveVersionId, identity.spaceId, now],
      );
    }
    await client.query(
      `UPDATE source_handler_versions SET status = 'active', activated_at = $3 WHERE id = $1 AND space_id = $2`,
      [versionId, identity.spaceId, now],
    );
    const updatedConnection = await client.query<{
      id: string;
      space_id: string;
      owner_user_id: string;
      status: string;
      fetch_frequency: string;
    }>(
      `UPDATE source_connections
          SET active_handler_version_id = $3,
              repair_status = 'ok',
              status = 'active',
              updated_at = $4
        WHERE id = $1 AND space_id = $2
        RETURNING id, space_id, owner_user_id, status`,
      [connectionId, identity.spaceId, versionId, now],
    );
    const connection = updatedConnection.rows[0];
    if (connection && channel && schedule) {
      await client.query(
        `UPDATE source_channels SET status='active', fetch_frequency=$3, schedule_rule_json=$4::jsonb, updated_at=$5 WHERE id=$1 AND space_id=$2`,
        [channel.id, identity.spaceId, channel.fetch_frequency, JSON.stringify(schedule.scheduleRule), now],
      );
      await upsertSourceChannelScanTask(client, {
        channel: { id: channel.id, space_id: channel.space_id, owner_user_id: channel.owner_user_id, status: "active", fetch_frequency: channel.fetch_frequency },
        nextRunAt: schedule.nextRunAt,
        updatedAt: now,
      });
    }
  });
  return now;
}

export function evaluateCustomSourceActivation(
  candidate: CustomSourcePolicyEnvelope,
  baseline: {
    activeEnvelope: CustomSourcePolicyEnvelope | null;
    spaceAllowedDomains: string[];
    credentialedSourcesAllowed?: boolean;
    spaceDefaultCapturePolicy?: string;
    spaceDefaultRetentionPolicy?: string;
  },
): { withinEnvelope: boolean; deltas: string[] } {
  const deltas: string[] = [];
  const activeEnvelope = baseline.activeEnvelope;
  const activeCredential = activeEnvelope?.credential_ref ?? null;
  const candidateCredential = candidate.credential_ref ?? null;
  if (
    candidateCredential &&
    candidateCredential !== activeCredential &&
    !(activeEnvelope === null && baseline.credentialedSourcesAllowed === true)
  ) {
    deltas.push(activeCredential ? "credential reference changed" : "credential reference requested");
  }
  if (candidate.browser_automation_enabled && activeEnvelope?.browser_automation_enabled !== true) {
    deltas.push("browser automation requested");
  }
  if (candidate.shell_enabled && activeEnvelope?.shell_enabled !== true) deltas.push("shell requested");
  if (
    candidate.dependency_installation_enabled &&
    activeEnvelope?.dependency_installation_enabled !== true
  ) {
    deltas.push("dependency installation requested");
  }

  const captureBaseline = activeEnvelope?.capture_policy ?? baseline.spaceDefaultCapturePolicy ?? null;
  const retentionBaseline =
    activeEnvelope?.retention_policy ?? baseline.spaceDefaultRetentionPolicy ?? null;
  const captureDelta = broadeningPolicyDelta(
    "capture policy",
    candidate.capture_policy,
    captureBaseline,
    SOURCE_CAPTURE_POLICY_RANK,
  );
  if (captureDelta) deltas.push(captureDelta);
  const retentionDelta = broadeningPolicyDelta(
    "retention policy",
    candidate.retention_policy,
    retentionBaseline,
    RETENTION_POLICY_RANK,
  );
  if (retentionDelta) deltas.push(retentionDelta);

  if (activeEnvelope && candidate.language !== activeEnvelope.language) {
    deltas.push(`handler language changed: ${activeEnvelope.language} -> ${candidate.language}`);
  }
  if ((activeEnvelope?.log_redaction_enabled ?? true) === true && candidate.log_redaction_enabled === false) {
    deltas.push("log redaction disabled");
  }
  if (activeEnvelope) {
    for (const key of POLICY_LIMIT_KEYS) {
      const candidateValue = candidate.limits[key];
      const activeValue = activeEnvelope.limits[key];
      if (typeof candidateValue === "number" && typeof activeValue === "number" && candidateValue > activeValue) {
        deltas.push(`policy limit increased: ${key} ${activeValue} -> ${candidateValue}`);
      }
    }
  }

  if (activeEnvelope) {
    const approvedOrigins = new Set(activeEnvelope.allowed_network_origins);
    for (const origin of candidate.allowed_network_origins) {
      if (!approvedOrigins.has(origin)) deltas.push(`network origin not previously approved: ${origin}`);
    }
  } else if (baseline.spaceAllowedDomains.length > 0) {
    for (const origin of candidate.allowed_network_origins) {
      const hostname = parseHostnameSafe(origin);
      if (!hostname || !domainAllowed(hostname, baseline.spaceAllowedDomains)) {
        deltas.push(`network origin not allowed by Space Custom Source policy: ${origin}`);
      }
    }
  }

  return { withinEnvelope: deltas.length === 0, deltas };
}

function requireCapturePolicy(value: string): SourceCapturePolicy {
  const parsed = parseSourceCapturePolicy(value);
  if (!parsed) throw new HttpError(422, "Unsupported Custom Source capture policy");
  return parsed;
}

function requireRetentionPolicy(value: string): SourceRetentionPolicy {
  const parsed = parseSourceRetentionPolicy(value);
  if (!parsed) throw new HttpError(422, "Unsupported Custom Source retention policy");
  return parsed;
}

function parseHostname(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return parsed.hostname;
  } catch {
    throw new HttpError(422, "endpoint_url must be a valid HTTP(S) URL");
  }
}

function parseOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return parsed.origin;
  } catch {
    throw new HttpError(422, "endpoint_url must be a valid HTTP(S) URL");
  }
}

function parseHostnameSafe(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function domainAllowed(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

const RETENTION_POLICY_RANK: Record<string, number> = {
  metadata_only: 0,
  summary_only: 1,
  full_text: 2,
  full_snapshot: 3,
  archived: 4,
};

const POLICY_LIMIT_KEYS = [
  "timeout_ms",
  "max_download_bytes",
  "max_output_bytes",
  "max_files",
  "max_items",
  "max_evidence_items",
  "log_max_bytes",
] as const satisfies ReadonlyArray<keyof CustomSourcePolicyEnvelope["limits"]>;

function broadeningPolicyDelta(
  label: string,
  candidateValue: string,
  baselineValue: string | null,
  rank: Record<string, number>,
): string | null {
  if (!baselineValue || candidateValue === baselineValue) return null;
  const candidateRank = rank[candidateValue];
  const baselineRank = rank[baselineValue];
  if (candidateRank === undefined || baselineRank === undefined) {
    return `${label} changed: ${baselineValue} -> ${candidateValue}`;
  }
  return candidateRank > baselineRank ? `${label} broadened: ${baselineValue} -> ${candidateValue}` : null;
}

export function customSourceProposalTypeForEnvelope(
  envelope: CustomSourcePolicyEnvelope,
  options: { credentialedSourcesAllowed: boolean },
): "custom_source_policy_delta" | "custom_source_credentialed_source" {
  if (envelope.credential_ref && !options.credentialedSourcesAllowed) {
    return "custom_source_credentialed_source";
  }
  return "custom_source_policy_delta";
}

export function customSourceProposalRisk(
  proposalType: "custom_source_policy_delta" | "custom_source_credentialed_source",
): "medium" | "high" {
  return proposalType === "custom_source_credentialed_source" ? "high" : "medium";
}

export function customSourceProposalPayload(input: {
  proposalType: "custom_source_policy_delta" | "custom_source_credentialed_source";
  connectionId: string;
  handlerVersionId: string;
  currentHandlerVersionId: string | null;
  currentEnvelope: CustomSourcePolicyEnvelope | null;
  proposedEnvelope: CustomSourcePolicyEnvelope;
  deltas: string[];
  requestedByUserId: string;
  nextCheckAt?: unknown;
  scheduleRule?: unknown;
}): Record<string, unknown> {
  const base = {
    proposal_type: input.proposalType,
    source_connection_id: input.connectionId,
    handler_version_id: input.handlerVersionId,
    current_handler_version_id: input.currentHandlerVersionId,
    current_policy_envelope_json: input.currentEnvelope,
    proposed_policy_envelope_json: input.proposedEnvelope,
    envelope_diff_json: { deltas: input.deltas },
  };
  if (input.nextCheckAt !== undefined) Object.assign(base, { next_check_at: input.nextCheckAt });
  if (input.scheduleRule !== undefined) Object.assign(base, { schedule_rule: input.scheduleRule });
  if (input.proposalType === "custom_source_credentialed_source") {
    return {
      ...base,
      credential_scope_json: {
        credential_ref: input.proposedEnvelope.credential_ref ?? null,
        allowed_network_origins: input.proposedEnvelope.allowed_network_origins,
      },
      requested_by_user_id: input.requestedByUserId,
    };
  }
  return base;
}

export function customSourceProposalReviewText(input: {
  proposalType: "custom_source_policy_delta" | "custom_source_credentialed_source";
  connectionId: string;
  handlerVersionId: string;
  activeHandlerVersionId: string | null;
  deltas: string[];
  proposedEnvelope: CustomSourcePolicyEnvelope;
}): { summary: string; proposedContent: string } {
  const lines = [
    `Connection: ${input.connectionId}`,
    `Handler version: ${input.handlerVersionId}`,
    `Current active version: ${input.activeHandlerVersionId ?? "none"}`,
    "",
    "Approval is required for these policy-envelope changes:",
    ...input.deltas.map((delta) => `- ${delta}`),
    "",
    "Proposed envelope:",
    `- type: ${input.proposalType}`,
    `- network origins: ${input.proposedEnvelope.allowed_network_origins.join(", ") || "none"}`,
    `- capture policy: ${input.proposedEnvelope.capture_policy}`,
    `- retention policy: ${input.proposedEnvelope.retention_policy}`,
    `- credential ref: ${input.proposedEnvelope.credential_ref ?? "none"}`,
    `- browser automation: ${input.proposedEnvelope.browser_automation_enabled ? "enabled" : "disabled"}`,
    `- shell: ${input.proposedEnvelope.shell_enabled ? "enabled" : "disabled"}`,
    `- dependency installation: ${input.proposedEnvelope.dependency_installation_enabled ? "enabled" : "disabled"}`,
    `- log redaction: ${input.proposedEnvelope.log_redaction_enabled ? "enabled" : "disabled"}`,
    `- limits: ${JSON.stringify(input.proposedEnvelope.limits)}`,
  ];
  return {
    summary: `Custom Source handler requires approval: ${input.deltas.join("; ")}`,
    proposedContent: lines.join("\n"),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "23505");
}
