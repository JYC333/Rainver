import { HttpError, objectValue, optionalString, type SpaceUserIdentity } from "../routeUtils/common.js";
import {
  retentionForCapturePolicy,
  SOURCE_CAPTURE_POLICIES,
  SOURCE_RETENTION_POLICIES,
  type SourceCapturePolicy,
  type SourceRetentionPolicy,
} from "./capturePolicy.js";
import type { SourceConnectionRow } from "./sourceRepositoryRows.js";

const TRUST_LEVELS = ["trusted", "normal", "untrusted"] as const;
const SOURCE_EGRESS_CLASSES = ["internal_only", "local_provider_allowed", "external_provider_allowed"] as const;
const DERIVED_WRITE_POLICIES = ["proposal_required", "disabled"] as const;
const IMPORT_TARGETS = ["activity", "knowledge", "memory_proposal", "source_artifact"] as const;
interface SourceEgressDefaults {
  allowLocalProviderEgress?: boolean;
  allowExternalModelEgress?: boolean;
  preferEgressDefaults?: boolean;
}

type CapturePolicy = SourceCapturePolicy;
type TrustLevel = (typeof TRUST_LEVELS)[number];
type RetentionPolicy = SourceRetentionPolicy;
type SourceEgressClass = (typeof SOURCE_EGRESS_CLASSES)[number];
type DerivedWritePolicy = (typeof DERIVED_WRITE_POLICIES)[number];
type ImportTarget = (typeof IMPORT_TARGETS)[number];

interface SourceConnectionConsent {
  schema_version: 1;
  owner_user_id: string;
  subject_user_ids: string[];
  allowed_reader_user_ids: string[];
  allowed_agent_ids: string[];
  allow_space_admins: boolean;
  allow_local_provider_egress: boolean;
  allow_external_model_egress: boolean;
}

interface SourceConnectionPolicy {
  schema_version: 1;
  source_egress_class: SourceEgressClass;
  source_egress_configured?: boolean;
  retention_policy: RetentionPolicy;
  import_trust_level: TrustLevel;
  derived_write_policy: DerivedWritePolicy;
  allowed_import_targets: ImportTarget[];
  revalidation: {
    required: true;
    viewer_scoped: true;
  };
}

export interface SourceConnectionGovernance {
  capturePolicy: CapturePolicy;
  trustLevel: TrustLevel;
  consent: SourceConnectionConsent;
  policy: SourceConnectionPolicy;
}

export function normalizeSourceConnectionReadGovernance(row: SourceConnectionRow): {
  consent: SourceConnectionConsent;
  policy: SourceConnectionPolicy;
} {
  const identity = { spaceId: row.space_id, userId: row.owner_user_id };
  const existingPolicy = sourceRecord(row.policy_json);
  const egressConfigured = existingPolicy.source_egress_configured === true;
  const defaults: SourceEgressDefaults = egressConfigured
    ? {}
    : sourceConnectionGovernanceDefaults({
        connector_type: row.connector_type,
        credential_id: row.credential_id,
      });
  const consent = normalizeConsent(identity, {}, sourceRecord(row.consent_json), {
    ...defaults,
    preferEgressDefaults: !egressConfigured && defaults.allowExternalModelEgress === true,
  });
  const capturePolicy = safeEnumValue(row.capture_policy, SOURCE_CAPTURE_POLICIES, "reference_only");
  const trustLevel = safeEnumValue(row.trust_level, TRUST_LEVELS, "normal");
  const policy = normalizePolicyForRead({
    existing: existingPolicy,
    egressConfigured,
    capturePolicy,
    trustLevel,
    consent,
  });
  return { consent, policy };
}

export function enforceSourceRetentionPolicy(policyJson: unknown, requested: RetentionPolicy): void {
  const policy = sourceRecord(policyJson);
  const retentionPolicy = enumValue(
    policy.retention_policy,
    SOURCE_RETENTION_POLICIES,
    "policy.retention_policy",
    "metadata_only",
  );
  if (retentionRank(requested) > retentionRank(retentionPolicy)) {
    throw new HttpError(403, `Source retention policy does not allow ${requested}`);
  }
}

export function enforceSourceDerivedImportTarget(policyJson: unknown, target: ImportTarget): void {
  const policy = sourceRecord(policyJson);
  const derivedWritePolicy = enumValue(
    policy.derived_write_policy,
    DERIVED_WRITE_POLICIES,
    "policy.derived_write_policy",
    "proposal_required",
  );
  if (derivedWritePolicy === "disabled") {
    throw new HttpError(403, "Source policy disables derived writes");
  }
  const targets = boundedEnumList(
    policy.allowed_import_targets,
    IMPORT_TARGETS,
    "policy.allowed_import_targets",
    ["activity", "source_artifact"],
    IMPORT_TARGETS.length,
  );
  if (!targets.includes(target)) {
    throw new HttpError(403, `Source policy does not allow ${target} imports`);
  }
}

export function normalizeSourceConnectionCreateGovernance(
  identity: SpaceUserIdentity,
  body: Record<string, unknown>,
): SourceConnectionGovernance {
  const capturePolicy = enumValue(body.capture_policy, SOURCE_CAPTURE_POLICIES, "capture_policy", "reference_only");
  const trustLevel = enumValue(body.trust_level, TRUST_LEVELS, "trust_level", "normal");
  const defaults = sourceConnectionGovernanceDefaults(body);
  const consent = normalizeConsent(identity, objectValue(body.consent), {}, defaults);
  const policy = normalizePolicy({
    raw: objectValue(body.policy),
    egressConfigured: sourceEgressConfiguredByRequest(body),
    capturePolicy,
    trustLevel,
    consent,
  });
  return { capturePolicy, trustLevel, consent, policy };
}

export function normalizeSourceConnectionUpdateGovernance(
  identity: SpaceUserIdentity,
  existing: SourceConnectionRow,
  body: Record<string, unknown>,
): {
  capturePolicy: CapturePolicy | null;
  trustLevel: TrustLevel | null;
  consent: SourceConnectionConsent | null;
  policy: SourceConnectionPolicy | null;
} {
  const capturePolicy = Object.hasOwn(body, "capture_policy")
    ? enumValue(body.capture_policy, SOURCE_CAPTURE_POLICIES, "capture_policy", null)
    : null;
  const trustLevel = Object.hasOwn(body, "trust_level")
    ? enumValue(body.trust_level, TRUST_LEVELS, "trust_level", null)
    : null;

  const ownerIdentity = { ...identity, userId: existing.owner_user_id };
  const consent = Object.hasOwn(body, "consent")
    ? normalizeConsent(ownerIdentity, objectValue(body.consent), sourceRecord(existing.consent_json))
    : null;

  const shouldUpdatePolicy =
    Object.hasOwn(body, "policy") || capturePolicy !== null || trustLevel !== null || consent !== null;
  const policy = shouldUpdatePolicy
    ? normalizePolicy({
        raw: Object.hasOwn(body, "policy") ? objectValue(body.policy) : {},
        existing: sourceRecord(existing.policy_json),
        egressConfigured: sourceEgressConfiguredByRequest(body) || sourceRecord(existing.policy_json).source_egress_configured === true,
        capturePolicy: capturePolicy ?? enumValue(existing.capture_policy, SOURCE_CAPTURE_POLICIES, "capture_policy", "reference_only"),
        trustLevel: trustLevel ?? enumValue(existing.trust_level, TRUST_LEVELS, "trust_level", "normal"),
        consent: consent ?? normalizeConsent(ownerIdentity, {}, sourceRecord(existing.consent_json)),
      })
    : null;

  return { capturePolicy, trustLevel, consent, policy };
}

function normalizeConsent(
  identity: SpaceUserIdentity,
  raw: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  defaults: SourceEgressDefaults = {},
): SourceConnectionConsent {
  const ownerUserId = identity.userId;
  const existingSubjects = strings(existing.subject_user_ids);
  const existingReaders = strings(existing.allowed_reader_user_ids);
  const localProviderFallback = defaults.preferEgressDefaults
    ? defaults.allowLocalProviderEgress ?? false
    : booleanValue(existing.allow_local_provider_egress, defaults.allowLocalProviderEgress ?? false);
  const externalModelFallback = defaults.preferEgressDefaults
    ? defaults.allowExternalModelEgress ?? false
    : booleanValue(existing.allow_external_model_egress, defaults.allowExternalModelEgress ?? false);
  return {
    schema_version: 1,
    owner_user_id: ownerUserId,
    subject_user_ids: boundedStrings(raw.subject_user_ids, "consent.subject_user_ids", existingSubjects.length ? existingSubjects : [ownerUserId], 50),
    allowed_reader_user_ids: boundedStrings(
      raw.allowed_reader_user_ids,
      "consent.allowed_reader_user_ids",
      existingReaders.length ? existingReaders : [ownerUserId],
      100,
    ),
    allowed_agent_ids: boundedStrings(raw.allowed_agent_ids, "consent.allowed_agent_ids", strings(existing.allowed_agent_ids), 100),
    allow_space_admins: booleanValue(raw.allow_space_admins, booleanValue(existing.allow_space_admins, true)),
    allow_local_provider_egress: booleanValue(
      raw.allow_local_provider_egress,
      localProviderFallback,
    ),
    allow_external_model_egress: booleanValue(
      raw.allow_external_model_egress,
      externalModelFallback,
    ),
  };
}

function sourceConnectionGovernanceDefaults(body: Record<string, unknown>): {
  allowLocalProviderEgress: boolean;
  allowExternalModelEgress: boolean;
} {
  const connectorType = optionalString(body.connector_type);
  const hasCredential = Boolean(optionalString(body.credential_id));
  const publicExternalSource = Boolean(
    !hasCredential &&
    (
      connectorType === "external_feed"
    ),
  );
  return {
    allowLocalProviderEgress: publicExternalSource,
    allowExternalModelEgress: publicExternalSource,
  };
}

function sourceEgressConfiguredByRequest(body: Record<string, unknown>): boolean {
  const consent = objectValue(body.consent);
  const policy = objectValue(body.policy);
  return (
    Object.hasOwn(consent, "allow_local_provider_egress") ||
    Object.hasOwn(consent, "allow_external_model_egress") ||
    Object.hasOwn(policy, "source_egress_class")
  );
}

function normalizePolicy(input: {
  raw: Record<string, unknown>;
  existing?: Record<string, unknown>;
  egressConfigured: boolean;
  capturePolicy: CapturePolicy;
  trustLevel: TrustLevel;
  consent: SourceConnectionConsent;
}): SourceConnectionPolicy {
  const existing = input.existing ?? {};
  const minimumRetention = retentionForCapture(input.capturePolicy);
  const retentionPolicy = enumValue(
    input.raw.retention_policy ?? existing.retention_policy,
    SOURCE_RETENTION_POLICIES,
    "policy.retention_policy",
    minimumRetention,
  );
  if (retentionRank(retentionPolicy) < retentionRank(minimumRetention)) {
    throw new HttpError(422, "policy.retention_policy cannot be narrower than capture_policy");
  }

  const sourceEgressClass = enumValue(
    input.raw.source_egress_class ?? existing.source_egress_class,
    SOURCE_EGRESS_CLASSES,
    "policy.source_egress_class",
    egressClassForConsent(input.consent),
  );
  validateEgressConsent(sourceEgressClass, input.consent);

  return {
    schema_version: 1,
    source_egress_class: sourceEgressClass,
    ...(input.egressConfigured ? { source_egress_configured: true } : {}),
    retention_policy: retentionPolicy,
    import_trust_level: input.trustLevel,
    derived_write_policy: enumValue(
      input.raw.derived_write_policy ?? existing.derived_write_policy,
      DERIVED_WRITE_POLICIES,
      "policy.derived_write_policy",
      "proposal_required",
    ),
    allowed_import_targets: boundedEnumList(
      input.raw.allowed_import_targets ?? existing.allowed_import_targets,
      IMPORT_TARGETS,
      "policy.allowed_import_targets",
      ["activity", "source_artifact"],
      IMPORT_TARGETS.length,
    ),
    revalidation: {
      required: true,
      viewer_scoped: true,
    },
  };
}

function normalizePolicyForRead(input: {
  existing: Record<string, unknown>;
  egressConfigured: boolean;
  capturePolicy: CapturePolicy;
  trustLevel: TrustLevel;
  consent: SourceConnectionConsent;
}): SourceConnectionPolicy {
  const minimumRetention = retentionForCapture(input.capturePolicy);
  const rawRetention = safeEnumValue(input.existing.retention_policy, SOURCE_RETENTION_POLICIES, minimumRetention);
  const retentionPolicy = retentionRank(rawRetention) < retentionRank(minimumRetention)
    ? minimumRetention
    : rawRetention;
  const fallbackEgress = egressClassForConsent(input.consent);
  const rawEgress = input.egressConfigured
    ? safeEnumValue(input.existing.source_egress_class, SOURCE_EGRESS_CLASSES, fallbackEgress)
    : fallbackEgress;
  const sourceEgressClass = egressAllowedByConsent(rawEgress, input.consent) ? rawEgress : fallbackEgress;
  return {
    schema_version: 1,
    source_egress_class: sourceEgressClass,
    ...(input.egressConfigured ? { source_egress_configured: true } : {}),
    retention_policy: retentionPolicy,
    import_trust_level: input.trustLevel,
    derived_write_policy: safeEnumValue(
      input.existing.derived_write_policy,
      DERIVED_WRITE_POLICIES,
      "proposal_required",
    ),
    allowed_import_targets: safeBoundedEnumList(
      input.existing.allowed_import_targets,
      IMPORT_TARGETS,
      ["activity", "source_artifact"],
      IMPORT_TARGETS.length,
    ),
    revalidation: {
      required: true,
      viewer_scoped: true,
    },
  };
}

function validateEgressConsent(sourceEgressClass: SourceEgressClass, consent: SourceConnectionConsent): void {
  if (sourceEgressClass === "external_provider_allowed" && !consent.allow_external_model_egress) {
    throw new HttpError(422, "policy.source_egress_class requires consent.allow_external_model_egress");
  }
  if (sourceEgressClass === "local_provider_allowed" && !egressAllowedByConsent(sourceEgressClass, consent)) {
    throw new HttpError(422, "policy.source_egress_class requires consent.allow_local_provider_egress");
  }
}

function egressAllowedByConsent(sourceEgressClass: SourceEgressClass, consent: SourceConnectionConsent): boolean {
  if (sourceEgressClass === "internal_only") return true;
  if (sourceEgressClass === "external_provider_allowed") return consent.allow_external_model_egress;
  if (
    sourceEgressClass === "local_provider_allowed" &&
    !consent.allow_local_provider_egress &&
    !consent.allow_external_model_egress
  ) {
    return false;
  }
  return true;
}

function egressClassForConsent(consent: SourceConnectionConsent): SourceEgressClass {
  if (consent.allow_external_model_egress) return "external_provider_allowed";
  if (consent.allow_local_provider_egress) return "local_provider_allowed";
  return "internal_only";
}

function retentionForCapture(capturePolicy: CapturePolicy): RetentionPolicy {
  return retentionForCapturePolicy(capturePolicy);
}

function retentionRank(value: RetentionPolicy): number {
  return SOURCE_RETENTION_POLICIES.indexOf(value);
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string,
  fallback: Values[number],
): Values[number];
function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string,
  fallback: null,
): Values[number] | null;
function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string,
  fallback: Values[number] | null,
): Values[number] | null {
  const normalized = optionalString(value);
  if (!normalized) return fallback;
  if ((allowed as readonly string[]).includes(normalized)) return normalized as Values[number];
  throw new HttpError(422, `${field} must be one of: ${allowed.join(", ")}`);
}

function safeEnumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  fallback: Values[number],
): Values[number] {
  const normalized = optionalString(value);
  if (!normalized) return fallback;
  return (allowed as readonly string[]).includes(normalized)
    ? normalized as Values[number]
    : fallback;
}

function boundedEnumList<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string,
  fallback: Values[number][],
  max: number,
): Values[number][] {
  if (value === null || value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new HttpError(422, `${field} must be an array`);
  if (value.length > max) throw new HttpError(422, `${field} must contain at most ${max} entries`);
  const out: Values[number][] = [];
  for (const item of value) {
    const normalized = optionalString(item);
    if (!normalized || !(allowed as readonly string[]).includes(normalized)) {
      throw new HttpError(422, `${field} contains an unsupported value`);
    }
    if (!out.includes(normalized as Values[number])) out.push(normalized as Values[number]);
  }
  return out;
}

function safeBoundedEnumList<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  fallback: Values[number][],
  max: number,
): Values[number][] {
  if (!Array.isArray(value) || value.length > max) return [...fallback];
  const out: Values[number][] = [];
  for (const item of value) {
    const normalized = optionalString(item);
    if (!normalized || !(allowed as readonly string[]).includes(normalized)) continue;
    if (!out.includes(normalized as Values[number])) out.push(normalized as Values[number]);
  }
  return out;
}

function boundedStrings(value: unknown, field: string, fallback: string[], max: number): string[] {
  if (value === null || value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new HttpError(422, `${field} must be an array`);
  if (value.length > max) throw new HttpError(422, `${field} must contain at most ${max} entries`);
  const out: string[] = [];
  for (const item of value) {
    const normalized = optionalString(item);
    if (!normalized) throw new HttpError(422, `${field} must contain only non-empty strings`);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function sourceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
