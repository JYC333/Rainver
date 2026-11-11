import { z } from "zod";
import adapters from "./acpAdapters.json" with { type: "json" };

export const REPOSITORY_ACP_ADAPTERS = adapters;
export function repositoryAcpAdapter(runtimeKey: string): { package: string; version: string; registry_id: string } | null {
  return Object.prototype.hasOwnProperty.call(adapters, runtimeKey) ? adapters[runtimeKey as keyof typeof adapters] : null;
}

export function isRepositoryAcpRegistryId(id: string): boolean {
  return Object.values(adapters).some(adapter => adapter.registry_id === id);
}

/** Bounded public identity/capabilities, never raw vendor metadata or account details. */
export const AcpRuntimeInfoSchema = z.object({
  protocol_version: z.literal(1),
  name: z.string().max(128).nullable(),
  version: z.string().max(100).nullable(),
  capabilities: z.object({
    resume: z.boolean(),
    compaction: z.boolean(),
    auth_status: z.boolean(),
    steering: z.boolean(),
    steering_idle_prompt_required: z.boolean(),
  }),
});
export type AcpRuntimeInfo = z.infer<typeof AcpRuntimeInfoSchema>;

export function acpRuntimeInfo(value: unknown): AcpRuntimeInfo | null {
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const result = obj(value);
  if (result.protocolVersion !== 1) return null;
  const info = obj(result.agentInfo), caps = obj(result.agentCapabilities);
  const session = obj(caps.sessionCapabilities), meta = obj(caps._meta), steering = obj(obj(result._meta).steering);
  const bounded = (v: unknown, max: number) => typeof v === "string" && v.trim() ? v.slice(0, max) : null;
  const stableVersion = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(String(info.version));
  const major = Number(stableVersion?.[1]), minor = Number(stableVersion?.[2]);
  const verifiedSteering = (info.name === "@agentclientprotocol/claude-agent-acp" && major === 0 && minor >= 101)
    || (info.name === "@agentclientprotocol/codex-acp" && major === 2 && minor >= 5);
  return {
    protocol_version: 1, name: bounded(info.name, 128), version: bounded(info.version, 100),
    capabilities: {
      resume: session.resume != null, compaction: session.compaction != null,
      auth_status: meta.authStatus != null,
      steering: steering.supported === true,
      // Verified current extension contract, not ACP wire-version inference.
      // A declared idle-safe contract takes precedence over vendor identity.
      steering_idle_prompt_required: steering.supported === true && (
        steering.idleBehavior === "promptRequired"
        || verifiedSteering
      ),
    },
  };
}

/** Exact physical attempt binding; never a vendor session identifier. */
export const RunLiveInputRequestSchema = z.object({
  binding_id: z.string().uuid(),
  content: z.string().trim().min(1).max(8000),
});
export type RunLiveInputRequest = z.infer<typeof RunLiveInputRequestSchema>;
export const RunLiveInputAvailabilitySchema = z.object({ available: z.boolean(), binding_id: z.string().uuid().nullable() });
export type RunLiveInputAvailability = z.infer<typeof RunLiveInputAvailabilitySchema>;
/** `pending`: recorded, and its delivery to the exact binding is still owed (never re-sent by the client). */
export const RunLiveInputResultSchema = z.object({
  state: z.enum(["pending", "injected", "not_injected", "unconfirmed"]),
  message_id: z.string().uuid(), delivery_id: z.string().uuid().nullable(),
});
export type RunLiveInputResult = z.infer<typeof RunLiveInputResultSchema>;
