import { domainDefinitions } from "../sourceAnnotation/index.js";
import { DEFAULT_INTEREST_PROFILE_SETTINGS, type InterestProfileSettings } from "./settings.js";

/**
 * Profile maturity.
 *
 * An explicit state rather than an inferred one. Every consumer of the profile
 * has to state what it does under `cold`, and "the tables happen to be empty"
 * is not something a caller can branch on legibly — it is how an empty profile
 * leaks into ranking as though it were a real signal.
 *
 * Cold start is a first-class product state, not a migration concern: a new
 * reader has nothing, must not be asked to fill anything in first, and still
 * gets a working digest.
 */
export type ProfileMaturity = "cold" | "warming" | "warm";

export interface MaturityInputs {
  /** Items this reader has actually read or skimmed, with a domain assigned. */
  readItemCount: number;
  /** Distinct skeleton domains among them. */
  coveredDomainCount: number;
}

/**
 * Sample sizes at which the profile starts being worth trusting.
 *
 * `warming` begins once there is enough signal to rank at all; `warm` once
 * coverage spans enough of the skeleton that an uncovered domain means
 * something. Below `warm`, "you have never read about X" is mostly a statement
 * about how new the reader is.
 */
export const WARMING_MIN_READ_ITEMS = DEFAULT_INTEREST_PROFILE_SETTINGS.warming_min_read_items;
export const WARM_MIN_READ_ITEMS = DEFAULT_INTEREST_PROFILE_SETTINGS.warm_min_read_items;
export const WARM_MIN_COVERED_DOMAINS = DEFAULT_INTEREST_PROFILE_SETTINGS.warm_min_covered_domains;

export function profileMaturity(
  inputs: MaturityInputs,
  settings: Pick<InterestProfileSettings, "warming_min_read_items" | "warm_min_read_items" | "warm_min_covered_domains"> = DEFAULT_INTEREST_PROFILE_SETTINGS,
): ProfileMaturity {
  if (inputs.readItemCount >= settings.warm_min_read_items && inputs.coveredDomainCount >= settings.warm_min_covered_domains) {
    return "warm";
  }
  if (inputs.readItemCount >= settings.warming_min_read_items) return "warming";
  return "cold";
}

/**
 * The share of serendipity slots that should be pure exploration rather than
 * targeted gap-filling, given how much the profile knows.
 *
 * A ramp rather than a switch. At `cold` the coverage distribution carries no
 * information, so every "gap" is an artifact of having no history and the
 * honest move is to explore; as coverage accumulates, an uncovered domain
 * increasingly means the reader genuinely has not been there, and targeting it
 * beats sampling at random.
 *
 * Never reaches zero. A profile that only ever fills computed gaps converges on
 * the reader's own history, which is the failure this whole mechanism exists to
 * prevent.
 */
export const MIN_EXPLORATION_SHARE = 0.25;

export function explorationShare(maturity: ProfileMaturity): number {
  switch (maturity) {
    case "cold": return 1;
    case "warming": return 0.5;
    case "warm": return MIN_EXPLORATION_SHARE;
  }
}

/**
 * Whether coverage is broad enough for "you have never encountered X" to be a
 * statement about the reader rather than about the sample.
 */
export function gapsAreMeaningful(maturity: ProfileMaturity): boolean {
  return maturity === "warm";
}

/** Total domains in the skeleton — the denominator of any coverage figure. */
export function skeletonSize(): number {
  return domainDefinitions().length;
}
