import type {
  CanonicalMessage,
  JsonValue,
  RunExecutionShape,
  RunInputAttachment,
  RunInputEnvelope,
  RunOutputDeclaration,
  RunToolGrant,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import { contractRecord } from "./contractSnapshot";
import type { RunRecord } from "./repository";

export function assembleRunInputEnvelope(
  run: RunRecord,
  overrides: {
    prompt?: string | null;
    instruction?: string | null;
    riskLevel?: string | null;
  } = {},
): RunInputEnvelope {
  const contract = contractRecord(run.contract_snapshot_json);
  const routeHints = recordValue(contract.route_hints_json);
  const modelOverride = recordValue(run.model_override_json);
  const prompt = overrides.prompt ?? run.prompt ?? null;
  const instruction = overrides.instruction ?? run.instruction ?? null;

  const envelope: RunInputEnvelope = {
    schema_version: "run_input.v1",
    run_id: run.id,
    space_id: run.space_id,
    instruction,
    task_goal: prompt,
    messages: canonicalMessages(modelOverride.messages),
    inputs: {
      direct: compactRecord({ prompt, instruction }),
      workflow: jsonValue(contract.workflow_input_json),
      upstream: jsonValue(contract.upstream_inputs_json),
    },
    attachments: attachmentManifest(
      contract.attachment_manifest_json ?? routeHints.attachments,
    ),
    project_folder_access: run.project_folder_id
      ? {
          project_folder_id: run.project_folder_id,
          access: run.required_sandbox_level === "none"
            || run.required_sandbox_level === "read_only"
            ? "read_only"
            : "read_write",
          mount_point: "working",
        }
      : null,
    output_contract: {
      schema_version: "run_output_contract.v1",
      structured_output: jsonValue(contract.structured_output_json),
      required_outputs: outputDeclarations(contract.required_outputs_json),
    },
    tool_grants: toolGrants(run.permission_snapshot_json),
    execution: {
      shape: executionShape(run, routeHints, contract.structured_output_json),
      risk_level: stringValue(overrides.riskLevel) ?? stringValue(contract.risk_level),
      required_sandbox_level: run.required_sandbox_level || "none",
      policy_ref: `run_permission_snapshot:${run.id}`,
      budget_ref: `run_contract:${run.id}`,
    },
  };
  assertNoSecretFields(envelope);
  return envelope;
}

/**
 * Display-safe projection of run_input.v1 for the Run Detail logical I/O
 * view. Mirrors the permission-filtering already applied to `output`
 * (canonical-shape only) and `events` (semantic-type allowlist): strips the
 * one field in the envelope that is a raw internal resource pointer rather
 * than something the Run's own visible viewer asked for, so a future
 * populated `attachment_manifest_json` cannot leak internal storage
 * locators through a run-visibility check that never validated per-resource
 * read access to the attachment's underlying object.
 */
export function logicalRunInput(
  envelope: RunInputEnvelope,
): Omit<RunInputEnvelope, "attachments"> & { attachments: Array<Omit<RunInputAttachment, "locator">> } {
  return {
    ...envelope,
    attachments: envelope.attachments.map(({ locator: _locator, ...rest }) => rest),
  };
}

function executionShape(
  run: RunRecord,
  routeHints: Record<string, unknown>,
  structuredOutput: unknown,
): RunExecutionShape {
  const declared = routeHints.execution_shape;
  if (
    declared === "conversational" ||
    declared === "structured_generation" ||
    declared === "agentic_files" ||
    declared === "code_execution"
  ) return declared;
  if (run.mode === "code" || run.mode === "implementation") return "code_execution";
  if (run.project_folder_id) return "agentic_files";
  if (structuredOutput !== null && structuredOutput !== undefined) return "structured_generation";
  return "conversational";
}

/**
 * Mirrors managedApiAdapter.ts's own message-shape validation exactly (all-
 * or-nothing on an invalid item; null content coerced to "" rather than
 * dropping the message) so the audited run_input.v1 view can never silently
 * diverge from what the Managed API adapter actually sends to the model —
 * a prior, independently-written copy of this logic disagreed on how a
 * tool-call-only turn (content: null) is handled, which meant Run Detail
 * could show a different message list than what really executed.
 */
function canonicalMessages(value: unknown): CanonicalMessage[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const messages: CanonicalMessage[] = [];
  for (const item of value) {
    const record = recordValue(item);
    const role = stringValue(record.role);
    if (!role) return [];
    if (record.content !== null && typeof record.content !== "string") return [];
    messages.push({ role, content: (record.content as string | null) ?? "" });
  }
  return messages;
}

function attachmentManifest(value: unknown): RunInputAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordValue(item);
    const kind = record.kind === "artifact" || record.kind === "source" ? record.kind : null;
    const refId = stringValue(record.ref_id ?? record.id);
    const purpose = stringValue(record.purpose);
    const locator = stringValue(record.locator);
    if (!kind || !refId || !purpose || !locator) return [];
    return [{
      kind,
      ref_id: refId,
      purpose,
      locator,
      media_type: stringValue(record.media_type),
      size_bytes: nonNegativeInteger(record.size_bytes),
    }];
  });
}

function outputDeclarations(value: unknown): RunOutputDeclaration[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = recordValue(item);
    const path = stringValue(record.path);
    if (!path) return [];
    if (path.startsWith("/") || path.startsWith("\\") || path.split(/[\\/]+/u).includes("..")) {
      throw new Error(`declared output path '${path}' escapes the Run Exchange`);
    }
    return [{
      name: stringValue(record.name) ?? `output_${index + 1}`,
      path,
      required: record.required !== false,
      media_type: stringValue(record.media_type),
      max_bytes: positiveInteger(record.max_bytes),
      json_schema: jsonValue(record.json_schema ?? record.schema),
    }];
  });
}

function toolGrants(value: unknown): RunToolGrant[] {
  const grants = recordValue(value).tool_grants;
  if (!Array.isArray(grants)) return [];
  return grants.flatMap((item) => {
    const record = recordValue(item);
    const actionId = stringValue(record.action_id);
    if (!actionId) return [];
    return [{
      action_id: actionId,
      capability_id: stringValue(record.capability_id),
      approval_behavior: record.approval_behavior === "pause" ? "pause" : "none",
      side_effecting: record.side_effecting === true,
    }];
  });
}

function compactRecord(
  value: Record<string, JsonValue | null | undefined>,
): Record<string, JsonValue> | null {
  const compact = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  ) as Record<string, JsonValue>;
  return Object.keys(compact).length > 0 ? compact : null;
}

function jsonValue(value: unknown): JsonValue | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

const FORBIDDEN_INPUT_KEYS = new Set([
  "api_key",
  "secret_ref",
  "encrypted_key",
  "credential_secret_ref",
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "private_key",
]);

function assertNoSecretFields(value: unknown, path: string[] = []): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (FORBIDDEN_INPUT_KEYS.has(key.toLowerCase())) {
      throw new Error(`run_input.v1 forbids secret field '${childPath.join(".")}'`);
    }
    assertNoSecretFields(child, childPath);
  }
}
