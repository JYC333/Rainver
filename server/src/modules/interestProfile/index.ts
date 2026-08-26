/**
 * Interest profile: the per-reader model the personal digest ranks against.
 *
 * Support package — the informationDigest module owns its authenticated HTTP
 * surface and consumes it from the cross-source daily pipeline.
 *
 * Owner-private by construction. In a shared space no other member may read a
 * profile, and per-user reading state never leaves the individual except as an
 * anonymous aggregate (INV-2).
 *
 * The write model is layered. The fact layer here is deterministic arithmetic
 * over events that already happened — no approval, no model call. The semantic
 * layer (deciding a recurring phrase means a new interest) is confirmation-
 * gated: only explicit owner acceptance or direct owner creation activates a
 * topic.
 *
 * It never learns from serendipity feedback (INV-1). Nothing in this package
 * reads the serendipity sections's signals, and nothing may be added that does:
 * the material serendipity surfaces is by definition low-interest, so any path
 * from it into these weights shrinks the quota monotonically until the reader
 * is back inside the bubble, with nothing looking broken along the way.
 */
export {
  PgInterestProfileRepository,
  COVERAGE_HALF_LIFE_DAYS,
  NEW_TOPIC_OCCURRENCE_THRESHOLD,
  NEW_TOPIC_READ_THRESHOLD,
  type CandidateStatus,
  type CoverageEntry,
  type InterestProfileRow,
  type InterestTopicRow,
  type TopicCandidateRow,
  type TopicOrigin,
  type TopicStatus,
} from "./repository.js";

export {
  InterestProfileService,
  FACT_LAYER_BATCH_SIZE,
  type FactLayerResult,
  type ProfileSnapshot,
} from "./service.js";

export {
  MIN_EXPLORATION_SHARE,
  WARMING_MIN_READ_ITEMS,
  WARM_MIN_COVERED_DOMAINS,
  WARM_MIN_READ_ITEMS,
  explorationShare,
  gapsAreMeaningful,
  profileMaturity,
  skeletonSize,
  type MaturityInputs,
  type ProfileMaturity,
} from "./maturity.js";
export {
  DEFAULT_INTEREST_PROFILE_SETTINGS,
  mergeInterestProfileSettings,
  resolveInterestProfileSettings,
  validateInterestProfileSettings,
  type InterestProfileSettings,
} from "./settings.js";

export { topicKeyFor, MAX_TOPIC_KEY_LENGTH } from "./topicKey.js";
