import type { CustomSourcePolicyEnvelope } from "@agent-space/protocol";
import type {
  ProposalApplierRegistry,
  ProposalApplyContext,
  ProposalApplyResult,
} from "../../proposals/applierRegistry.js";
import {
  HANDLER_VERSION_COLUMNS,
  handlerVersionOut,
  type HandlerVersionRow,
} from "./customSourceHandlerRepository.js";
import {
  getSourceChannelScanTask,
  upsertSourceChannelScanTask,
} from "../sourceConnectionScheduler.js";
import { resolveRequestedSourceSchedule } from "../sourceScheduleInput.js";

const CUSTOM_SOURCE_PROPOSAL_TYPES = [
  "custom_source_policy_delta",
  "custom_source_credentialed_source",
  "custom_source_repair_activation",
] as const;

type CustomSourceProposalType = (typeof CUSTOM_SOURCE_PROPOSAL_TYPES)[number];

interface SourceConnectionRow {
  id: string;
  space_id: string;
  owner_user_id: string;
  status: string;
  channel_id: string;
  fetch_frequency: string;
  schedule_rule_json: unknown;
  active_handler_version_id: string | null;
  handler_kind: string;
  deleted_at: unknown;
}

export class CustomSourceProposalApplyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CustomSourceProposalApplyError";
  }
}

export function registerCustomSourceProposalAppliers(registry: ProposalApplierRegistry): void {
  for (const proposalType of CUSTOM_SOURCE_PROPOSAL_TYPES) {
    registry.register(proposalType, applyCustomSourceProposal);
  }
}

async function applyCustomSourceProposal(
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> {
  const proposalType = context.proposal.proposal_type as CustomSourceProposalType;
  const payload = context.proposal.payload_json ?? {};
  const connectionId = requiredString(payload.source_connection_id, "source_connection_id");
  const targetVersionId =
    proposalType === "custom_source_repair_activation"
      ? requiredString(payload.new_handler_version_id, "new_handler_version_id")
      : requiredString(payload.handler_version_id, "handler_version_id");

  const connection = await loadConnection(context, connectionId);
  const version = await loadHandlerVersion(context, connectionId, targetVersionId);
  validateVersionBinding(context, version);

  if (proposalType === "custom_source_policy_delta") {
    await validatePolicyDeltaPayload(context, connection, version, payload);
  } else if (proposalType === "custom_source_credentialed_source") {
    await validateCredentialedSourcePayload(context, connection, version, payload);
  } else {
    await validateRepairActivationPayload(context, connection, version, payload);
  }

  const activated = await activateHandlerVersion(context, connection, version, payload);
  const now = new Date().toISOString();
  return {
    result_type: "custom_source_handler_version",
    result: {
      source_connection_id: connection.id,
      handler_version_id: version.id,
      previous_handler_version_id: connection.active_handler_version_id,
      status: "active",
      handler_version: handlerVersionOut(activated),
    },
    proposalPayloadPatch: {
      ...payload,
      accepted_by_user_id: context.userId,
      accepted_at: now,
      activated_handler_version_id: version.id,
      previous_handler_version_id: connection.active_handler_version_id,
    },
  };
}

async function loadConnection(
  context: ProposalApplyContext,
  connectionId: string,
): Promise<SourceConnectionRow> {
  const result = await context.db.query<SourceConnectionRow>(
    `SELECT sc.id, sc.space_id, sc.owner_user_id, sc.status,
            ch.id AS channel_id, ch.fetch_frequency, ch.schedule_rule_json,
            ch.status AS channel_status, sc.active_handler_version_id, sc.handler_kind, sc.deleted_at
       FROM source_connections sc
       JOIN source_channels ch ON ch.source_connection_id = sc.id AND ch.status <> 'archived'
      WHERE sc.id = $1 AND sc.space_id = $2
      ORDER BY ch.updated_at DESC
      LIMIT 1
      FOR UPDATE`,
    [connectionId, context.proposal.space_id],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at !== null) {
    throw new CustomSourceProposalApplyError(404, "Custom Source connection not found");
  }
  if (row.handler_kind !== "generated_custom") {
    throw new CustomSourceProposalApplyError(422, "Source connection is not a Custom Source");
  }
  return row;
}

async function loadHandlerVersion(
  context: ProposalApplyContext,
  connectionId: string,
  versionId: string,
): Promise<HandlerVersionRow> {
  const result = await context.db.query<HandlerVersionRow>(
    `SELECT ${HANDLER_VERSION_COLUMNS}
       FROM source_handler_versions
      WHERE id = $1
        AND space_id = $2
        AND source_connection_id = $3
      FOR UPDATE`,
    [versionId, context.proposal.space_id, connectionId],
  );
  const row = result.rows[0];
  if (!row) throw new CustomSourceProposalApplyError(404, "Handler version not found");
  return row;
}

function validateVersionBinding(context: ProposalApplyContext, version: HandlerVersionRow): void {
  if (version.proposal_id !== context.proposal.id) {
    throw new CustomSourceProposalApplyError(409, "Handler version is not bound to this proposal");
  }
  if (version.status !== "pending_approval") {
    throw new CustomSourceProposalApplyError(
      409,
      `Handler version must be pending approval to apply (was ${version.status})`,
    );
  }
  const testResult = version.test_result_json as { status?: string } | null;
  if (testResult?.status !== "succeeded") {
    throw new CustomSourceProposalApplyError(409, "Handler version must have a successful test result");
  }
}

async function validatePolicyDeltaPayload(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
  version: HandlerVersionRow,
  payload: Record<string, unknown>,
): Promise<void> {
  validateExpectedActivePointer(connection, nullableString(payload.current_handler_version_id));
  await validateCurrentEnvelope(context, connection, payload.current_policy_envelope_json);
  validateProposedEnvelope(version, payload.proposed_policy_envelope_json);
}

async function validateCredentialedSourcePayload(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
  version: HandlerVersionRow,
  payload: Record<string, unknown>,
): Promise<void> {
  validateExpectedActivePointer(connection, nullableString(payload.current_handler_version_id));
  await validateCurrentEnvelope(context, connection, payload.current_policy_envelope_json);
  validateProposedEnvelope(version, payload.proposed_policy_envelope_json);
  const envelope = envelopeOf(version);
  if (!envelope.credential_ref) {
    throw new CustomSourceProposalApplyError(422, "Credentialed Custom Source proposal has no credential_ref");
  }
}

async function validateRepairActivationPayload(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
  version: HandlerVersionRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const expectedPreviousId = requiredString(
    payload.previous_handler_version_id,
    "previous_handler_version_id",
  );
  validateExpectedActivePointer(connection, expectedPreviousId);
  if (payload.envelope_unchanged !== true) {
    throw new CustomSourceProposalApplyError(
      409,
      "Repair activation cannot broaden permissions; use a policy-delta proposal",
    );
  }
  const activeEnvelope = await activeEnvelopeFor(context, connection);
  if (!activeEnvelope) {
    throw new CustomSourceProposalApplyError(409, "Repair activation requires an active baseline version");
  }
  if (!jsonDeepEqual(activeEnvelope, envelopeOf(version))) {
    throw new CustomSourceProposalApplyError(409, "Repair activation envelope changed from active baseline");
  }
}

function validateExpectedActivePointer(
  connection: SourceConnectionRow,
  expectedActiveVersionId: string | null,
): void {
  if (connection.active_handler_version_id !== expectedActiveVersionId) {
    throw new CustomSourceProposalApplyError(
      409,
      "Custom Source active handler changed after this proposal was created",
    );
  }
}

async function validateCurrentEnvelope(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
  expectedEnvelope: unknown,
): Promise<void> {
  const activeEnvelope = await activeEnvelopeFor(context, connection);
  if (!jsonDeepEqual(activeEnvelope, expectedEnvelope ?? null)) {
    throw new CustomSourceProposalApplyError(
      409,
      "Custom Source active policy envelope changed after this proposal was created",
    );
  }
}

function validateProposedEnvelope(version: HandlerVersionRow, expectedEnvelope: unknown): void {
  if (!jsonDeepEqual(envelopeOf(version), expectedEnvelope)) {
    throw new CustomSourceProposalApplyError(
      409,
      "Handler version policy envelope changed after this proposal was created",
    );
  }
}

async function activeEnvelopeFor(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
): Promise<CustomSourcePolicyEnvelope | null> {
  if (!connection.active_handler_version_id) return null;
  const result = await context.db.query<HandlerVersionRow>(
    `SELECT ${HANDLER_VERSION_COLUMNS}
       FROM source_handler_versions
      WHERE id = $1
        AND space_id = $2
        AND source_connection_id = $3`,
    [connection.active_handler_version_id, context.proposal.space_id, connection.id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new CustomSourceProposalApplyError(409, "Active handler version not found");
  }
  return envelopeOf(row);
}

async function activateHandlerVersion(
  context: ProposalApplyContext,
  connection: SourceConnectionRow,
  version: HandlerVersionRow,
  payload: Record<string, unknown>,
): Promise<HandlerVersionRow> {
  const now = new Date().toISOString();
  if (connection.active_handler_version_id) {
    await context.db.query(
      `UPDATE source_handler_versions
          SET status = 'superseded', superseded_at = $3
        WHERE id = $1 AND space_id = $2`,
      [connection.active_handler_version_id, context.proposal.space_id, now],
    );
  }
  const updated = await context.db.query<HandlerVersionRow>(
    `UPDATE source_handler_versions
        SET status = 'active', activated_at = $3
      WHERE id = $1
        AND space_id = $2
      RETURNING ${HANDLER_VERSION_COLUMNS}`,
    [version.id, context.proposal.space_id, now],
  );
  const existingScheduleTask = await getSourceChannelScanTask(context.db, connection.channel_id);
  const schedule = resolveRequestedSourceSchedule({
    body: { next_check_at: payload.next_check_at, schedule_rule: payload.schedule_rule },
    status: "active",
    fetchFrequency: connection.fetch_frequency,
    existingNextCheckAt: existingScheduleTask?.next_run_at,
    existingScheduleRule: connection.schedule_rule_json,
  });
  const updatedConnection = await context.db.query<SourceConnectionRow>(
    `UPDATE source_connections
        SET active_handler_version_id = $3,
            repair_status = 'ok',
            status = 'active',
            updated_at = $4
      WHERE id = $1 AND space_id = $2
      RETURNING id, space_id, owner_user_id, status,
                active_handler_version_id, handler_kind, deleted_at`,
    [connection.id, context.proposal.space_id, version.id, now],
  );
  const scheduleConnection = updatedConnection.rows[0];
  if (scheduleConnection) {
    await context.db.query(
      `UPDATE source_channels SET status='active', schedule_rule_json=$3::jsonb, updated_at=$4 WHERE id=$1 AND space_id=$2`,
      [connection.channel_id, context.proposal.space_id, JSON.stringify(schedule.scheduleRule ?? null), now],
    );
    await upsertSourceChannelScanTask(context.db, {
      channel: {
        id: connection.channel_id,
        space_id: context.proposal.space_id,
        owner_user_id: connection.owner_user_id,
        status: "active",
        fetch_frequency: connection.fetch_frequency,
      },
      nextRunAt: schedule.nextRunAt,
      updatedAt: now,
    });
  }
  return updated.rows[0]!;
}

function envelopeOf(version: HandlerVersionRow): CustomSourcePolicyEnvelope {
  return version.policy_envelope_json as CustomSourcePolicyEnvelope;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new CustomSourceProposalApplyError(422, `Proposal payload missing ${field}`);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}
