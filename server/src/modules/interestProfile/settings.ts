export interface InterestProfileSettings {
  coverage_half_life_days: number;
  new_topic_occurrence_threshold: number;
  new_topic_read_threshold: number;
  warming_min_read_items: number;
  warm_min_read_items: number;
  warm_min_covered_domains: number;
  interest_slots: number;
  serendipity_slots: number;
  interesting_cooldown_days: number;
  neutral_cooldown_days: number;
  probe_domain_budget: number;
}

export const DEFAULT_INTEREST_PROFILE_SETTINGS: InterestProfileSettings = {
  coverage_half_life_days: 180,
  new_topic_occurrence_threshold: 4,
  new_topic_read_threshold: 2,
  warming_min_read_items: 15,
  warm_min_read_items: 60,
  warm_min_covered_domains: 5,
  interest_slots: 6,
  serendipity_slots: 2,
  interesting_cooldown_days: 7,
  neutral_cooldown_days: 30,
  probe_domain_budget: 3,
};

/**
 * At most this many external requests per weekly probe: the
 * `information_digest_probe_runs.request_count` CHECK holds the same bound.
 */
export const MAX_PROBE_DOMAIN_BUDGET = 3;

const RANGES: Record<keyof InterestProfileSettings, readonly [number, number]> = {
  coverage_half_life_days: [1, 3_650],
  new_topic_occurrence_threshold: [1, 100],
  new_topic_read_threshold: [1, 100],
  warming_min_read_items: [1, 10_000],
  warm_min_read_items: [1, 10_000],
  warm_min_covered_domains: [1, 60],
  interest_slots: [1, 20],
  serendipity_slots: [0, 10],
  interesting_cooldown_days: [1, 365],
  neutral_cooldown_days: [1, 365],
  probe_domain_budget: [1, MAX_PROBE_DOMAIN_BUDGET],
};

export function resolveInterestProfileSettings(value: unknown): InterestProfileSettings {
  const input = recordValue(value);
  const resolved = { ...DEFAULT_INTEREST_PROFILE_SETTINGS };
  for (const key of Object.keys(RANGES) as Array<keyof InterestProfileSettings>) {
    const candidate = input[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) resolved[key] = candidate;
  }
  // The setting once allowed up to ten; a budget saved then probes at the cap.
  resolved.probe_domain_budget = Math.min(resolved.probe_domain_budget, MAX_PROBE_DOMAIN_BUDGET);
  validateInterestProfileSettings(resolved);
  return resolved;
}

export function mergeInterestProfileSettings(
  current: unknown,
  patch: Partial<InterestProfileSettings>,
): InterestProfileSettings {
  const merged = { ...resolveInterestProfileSettings(current), ...patch };
  validateInterestProfileSettings(merged);
  return merged;
}

export function validateInterestProfileSettings(settings: InterestProfileSettings): void {
  for (const key of Object.keys(RANGES) as Array<keyof InterestProfileSettings>) {
    const value = settings[key];
    const [min, max] = RANGES[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  if (settings.new_topic_read_threshold > settings.new_topic_occurrence_threshold) {
    throw new Error("new_topic_read_threshold cannot exceed new_topic_occurrence_threshold");
  }
  if (settings.warm_min_read_items < settings.warming_min_read_items) {
    throw new Error("warm_min_read_items cannot be below warming_min_read_items");
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
