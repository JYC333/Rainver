/**
 * System module service — the server's self-descriptors.
 *
 * Pure functions only: liveness body and the feature advertisement. They report
 * only the server's own state.
 *
 * IMPORTANT DISTINCTION:
 *   GET /api/v1/server/features (this file) advertises SERVER INFRASTRUCTURE capabilities —
 *   always-on features baked into the server binary. It is NOT a product feature toggle.
 *   It does NOT represent optional product module enablement.
 *
 *   GET /api/v1/plugins is the OFFICIAL OPTIONAL MODULE control plane — it returns
 *   descriptors and per-space/user enablement state for optional product features
 *   such as diary. These are NOT listed here as always-on features.
 *
 *   GET /api/v1/catalog (catalog module) lists CAPABILITY manifests — agent AI skill
 *   descriptors. Also NOT product plugins.
 *
 *   See .agent/architecture/OFFICIAL_OPTIONAL_MODULES.md and ADR 0006.
 */

import type { ServerConfig } from "../../config.js";
import * as protocol from "@rainver/protocol";
import { getDbPool } from "../../db/pool.js";
import type { Queryable } from "../routeUtils/common.js";

export const SERVER_SERVICE_NAME = "server";

export interface HealthBody {
  status: "ok" | "error";
  service: string;
  checks: { database: "ok" | "error" };
}

let healthDatabaseOverride: Queryable | null = null;

export function __setHealthDatabaseForTests(db: Queryable | null): void {
  healthDatabaseOverride = db;
}

export async function healthBody(config: ServerConfig): Promise<HealthBody> {
  if (!config.databaseUrl && !healthDatabaseOverride) {
    return { status: "error", service: SERVER_SERVICE_NAME, checks: { database: "error" } };
  }
  try {
    const db = healthDatabaseOverride ?? getDbPool(config.databaseUrl!);
    await db.query("SELECT 1 AS healthy");
    return { status: "ok", service: SERVER_SERVICE_NAME, checks: { database: "ok" } };
  } catch {
    return { status: "error", service: SERVER_SERVICE_NAME, checks: { database: "error" } };
  }
}

/**
 * Detect whether the shared protocol package is present.
 */
export function isProtocolPackageDetected(): boolean {
  // The server imports the protocol package statically, so a running server
  // has it by construction; this only guards against a build that shipped
  // without the package's exports (an empty namespace).
  return Object.keys(protocol).length > 0;
}

export interface FeaturesBody {
  service: string;
  features: string[];
}

export function computeFeatures(config: ServerConfig): string[] {
  const features = [
    "server_health",
    "catalog_read",
    "run_event_sse_stream",
    "frontend_support_read_model_facades",
    "runtime_tools_controlled_installer",
    "native_identity_auth",
    "native_google_oauth",
    "native_space_membership",
    "api_keys_feature_gate",
    "space_default_seeding",
    "runtime_adapter_catalog",
    "runtime_tool_bindings_server_authority",
    "providers_read_server_authority",
    "providers_credentials_server_authority",
    "policy_enforcement_server_authority",
    "sessions_server_authority",
    "runs_server_authority",
    "runs_child_resources_server_authority",
    "artifacts_server_authority",
    "projects_server_authority",
    "agent_templates_server_authority",
    "capabilities_server_authority",
    "personal_memory_grants_server_authority",
    "evolution_server_authority",
    "content_publications_server_authority",
    "project_folder_execution_configs_server_authority",
    "graph_projection_server_authority",
    "server_agent_runtime_host",
    "config_semantic_validation",
    "notification_webhook_egress_policy_gate",
  ];
  features.push("proposals_server_authority");
  features.push("room_conversation_server_authority");
  features.push("context_assembly_server_authority");
  features.push("memory_server_authority");
  if (config.enableNotificationWebhookEgress) {
    features.push("notification_webhook_egress");
  }
  if (isProtocolPackageDetected()) features.push("protocol_package_detected");
  // Advertises that the official optional module control plane is available.
  // This does NOT mean any specific optional module is enabled — use
  // GET /api/v1/plugins/effective for per-space/user module enablement state.
  features.push("official_optional_modules");
  return features;
}

export function featuresBody(config: ServerConfig): FeaturesBody {
  return { service: SERVER_SERVICE_NAME, features: computeFeatures(config) };
}
