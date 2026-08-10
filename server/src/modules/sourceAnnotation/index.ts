/**
 * Source annotation: the objective classification pass over incoming source
 * material that the cross-source digest pipeline ranks against.
 *
 * Support package — no HTTP routes of its own. It owns the domain skeleton
 * (the serendipity reference frame), the depth/genre vocabulary, and
 * `source_item_annotations`.
 *
 * Boundary with Sources: Sources owns capture and per-rule, per-connection
 * post-processing configured by a user. This pass is system-level and runs for
 * every subscribed source regardless of whether a rule exists, because an
 * unannotated item silently never reaches the recommendation pool.
 */
export {
  adjacentDomainKeys,
  distantDomainKeys,
  domainDefinitions,
  domainKeys,
  getDomain,
  isKnownDomain,
  registerDomain,
  type DomainDefinition,
  type DomainGroup,
} from "./domainSkeleton";

export {
  ANNOTATION_DEPTHS,
  ANNOTATION_GENRES,
  isAnnotationDepth,
  isAnnotationGenre,
  type AnnotationDepth,
  type AnnotationGenre,
} from "./vocabulary";

export {
  PgSourceAnnotationRepository,
  SOURCE_ANNOTATION_JOB_TYPE,
  type SourceAnnotationRow,
  type SourceAnnotationStatus,
} from "./repository";

export { enqueueItemsForAnnotation } from "./eventEmitter";
export { registerSourceAnnotationHandler } from "./job";
export { enqueuePendingSourceAnnotationWork } from "./scheduler";
export { SourceAnnotationService, type AnnotationSweepResult } from "./service";
export {
  SOURCE_ANNOTATION_SCHEMA_ID,
  parseSourceAnnotationResult,
  sourceAnnotationOutputContract,
} from "./resultParser";
