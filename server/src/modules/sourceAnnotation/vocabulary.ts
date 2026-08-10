/**
 * The two axes depth/genre inversion reads.
 *
 * They are separate because they invert independently: a reader who only ever
 * sees `headline`-depth material needs depth inversion regardless of genre, and
 * a reader who only ever reads `news` needs genre inversion even when the news
 * they read is deep. Collapsing them into one "kind" field made the inversion
 * rule unable to express either.
 *
 * Kept as small closed vocabularies rather than free-form strings for the same
 * reason the domain skeleton is coarse: an open vocabulary produces a
 * distribution too sparse to invert against.
 */

export const ANNOTATION_DEPTHS = ["headline", "overview", "analysis", "deep"] as const;
export type AnnotationDepth = typeof ANNOTATION_DEPTHS[number];

export const ANNOTATION_DEPTH_HINTS: Record<AnnotationDepth, string> = {
  headline: "an announcement or brief report; conveys that something happened",
  overview: "a survey or roundup; covers breadth without arguing a position",
  analysis: "argues a position or explains a mechanism in depth",
  deep: "primary material: original research, full technical detail, or a long-form treatment",
};

export const ANNOTATION_GENRES = [
  "news",
  "explainer",
  "opinion",
  "research",
  "tutorial",
  "reference",
  "narrative",
  "discussion",
] as const;
export type AnnotationGenre = typeof ANNOTATION_GENRES[number];

export const ANNOTATION_GENRE_HINTS: Record<AnnotationGenre, string> = {
  news: "reports events",
  explainer: "explains how something works for a non-specialist",
  opinion: "argues what should be the case",
  research: "presents original findings, methods, or results",
  tutorial: "teaches the reader to do something",
  reference: "documentation, specifications, data",
  narrative: "story, essay, personal account, fiction",
  discussion: "thread, interview, Q&A, correspondence",
};

export function isAnnotationDepth(value: unknown): value is AnnotationDepth {
  return typeof value === "string" && (ANNOTATION_DEPTHS as readonly string[]).includes(value);
}

export function isAnnotationGenre(value: unknown): value is AnnotationGenre {
  return typeof value === "string" && (ANNOTATION_GENRES as readonly string[]).includes(value);
}

/** Upper bound on stored topic phrases per item. */
export const MAX_TOPIC_CANDIDATES = 5;

/** Upper bound on a stored topic phrase, in characters. */
export const MAX_TOPIC_CANDIDATE_LENGTH = 64;
