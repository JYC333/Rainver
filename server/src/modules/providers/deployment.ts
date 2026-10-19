/**
 * How a Provider is deployed, as its owner declared it.
 *
 * `cloud` is the default and the only answer for a vendor with a published
 * endpoint. `trusted_local` is a declaration a Space owner or admin makes
 * about a self-hosted service — the machine itself, a Compose sibling, a
 * trusted LAN box — that performs inference where it runs and forwards
 * nothing to a hosted model. The egress policy judges a local destination on
 * this declaration together with the endpoint and the model; the vendor's
 * name and a loopback URL prove nothing on their own.
 */
import { listProviderVendors } from "./vendors.js";

export type ProviderDeployment = "cloud" | "trusted_local";

export const PROVIDER_DEPLOYMENTS: readonly ProviderDeployment[] = ["cloud", "trusted_local"];

/** Vendors that can be self-hosted at all; every other vendor is a cloud service. */
export const SELF_HOSTABLE_PROVIDER_TYPES: ReadonlySet<string> = new Set(
  listProviderVendors().filter((vendor) => vendor.selfHostable).map((vendor) => vendor.id),
);

export function providerDeployment(configJson: unknown): ProviderDeployment {
  const config = configJson !== null && typeof configJson === "object" && !Array.isArray(configJson)
    ? configJson as Record<string, unknown>
    : {};
  return config.deployment === "trusted_local" ? "trusted_local" : "cloud";
}

export function isProviderDeployment(value: unknown): value is ProviderDeployment {
  return typeof value === "string" && (PROVIDER_DEPLOYMENTS as readonly string[]).includes(value);
}
