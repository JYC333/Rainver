import { createHash } from "node:crypto";
import type { Queryable } from "../../routeUtils/common.js";

/**
 * The scope contract of the briefing kernel. A scope adapter states who the
 * briefing is for (Space, subject, audience) and where its material and
 * context come from; the kernel (manifest, delta, prompt, validation, read
 * re-authorization) is the same for every scope. An adapter never decides
 * novelty, validation or visibility rules — only facts about its scope.
 */

export interface BriefingScope {
  type: "project" | "personal";
  spaceId: string;
  projectId: string | null;
  ownerUserId: string | null;
  /** `project:<id>` / `personal:<user>`: uniqueness and lock key. */
  key: string;
}

export interface BriefingLens { kind: "following" | "monitoring" | "corpus"; label: string }

/**
 * Dependencies: every record whose text can reach the model, with the
 * revision it was read at and the Source connection whose consent governs
 * it. Dispatch, publication and reads re-check exactly these, so nothing can
 * ride into a prompt or stay visible through another item of its family.
 */
export interface BriefingItemDep { id: string; connection_id: string | null; revision: string }
/** `at`: when the analysis or judgment was made, for the collecting Source's reader-delivery window. */
export interface BriefingAnnotationDep { id: string; item_id: string; connection_id: string | null; revision: string; at: string | null }
export interface BriefingSignalDep {
  kind: "goal_item" | "decision" | "corpus_item";
  id: string;
  item_id: string;
  /** The Source that collected or judged it (a Following binding's Source, a decision's channel Source, a Corpus entry's Source). */
  connection_id: string | null;
  revision: string;
  at: string | null;
}
export interface BriefingDeps { items: BriefingItemDep[]; annotations: BriefingAnnotationDep[]; signals: BriefingSignalDep[] }

/** One scope judgment on an item: why the scope offers it, and the existing short analysis behind it. */
export interface BriefingSignal {
  lens: BriefingLens;
  text: string | null;
  activity_at: string;
  change_at: string | null;
  dep: BriefingSignalDep;
}

/** One Source item the scope offers, already passed through the scope's audience gate. */
export interface BriefingCandidate {
  source_item_id: string;
  family_key: string;
  /** The item's own content revision (`content_hash:body_revision`). */
  content_revision: string;
  connection_id: string | null;
  title: string;
  source_domain: string | null;
  occurred_at: string | null;
  first_seen_at: string;
  /** The latest scope activity on it, or change of its body or analysis. */
  activity_at: string;
  /** Latest evidenced change recorded for it, if any. */
  change_at: string | null;
  /** Agent-provided material nobody verified independently. */
  unverified: boolean;
  summary: string | null;
  excerpt: string | null;
  annotation: BriefingAnnotationDep | null;
  signals: BriefingSignal[];
}

export interface BriefingContextEntry {
  kind: "project_goal" | "project_scope" | "project_success" | "project_constraints" | "project_focus" | "task";
  label: string;
  text: string;
  /** What the entry was read from, so a read can tell whether it is still shared and current. */
  source: { type: "brief_version" | "task"; id: string; revision: string };
}

export interface BriefingWindow {
  /** Exclusive lower bound of scope activity or content/analysis change. */
  since: string;
  cutoff: string;
  /**
   * Evaluated again regardless of time: items left pending by the previous
   * version (not analysed, over the bound, refused, not shared), and the
   * previously briefed material offered as comparison background.
   */
  pinnedItemIds: string[];
}

export interface BriefingScopeAdapter {
  scope: BriefingScope;
  /** Everyone the result is shared with, now. */
  audience(db: Queryable): Promise<string[]>;
  canRead(db: Queryable, userId: string): Promise<boolean>;
  canGenerate(db: Queryable, userId: string): Promise<boolean>;
  /** Candidates every audience member may fully read; `not_shared_ids` are those left out for that reason (carried, never sent). */
  candidates(db: Queryable, window: BriefingWindow): Promise<{ rows: BriefingCandidate[]; not_shared_ids: string[] }>;
  /** Context every audience member may read; bounded. */
  context(db: Queryable): Promise<BriefingContextEntry[]>;
  /** Of these items, those the current audience may still fully read. */
  allowedItems(db: Queryable, itemIds: string[]): Promise<Set<string>>;
  /**
   * The current revision of each scope signal the whole audience may still
   * read through its collecting Source; absent = no longer offered.
   */
  signalState(db: Queryable, signals: BriefingSignalDep[]): Promise<Map<string, string>>;
  /** Of these context sources, those still shared with the audience; and those no longer current. */
  contextState(db: Queryable, sources: BriefingContextEntry["source"][]): Promise<{ allowed: Set<string>; outdated: boolean }>;
}

/** Bounded inputs. Defaults are starting values to be tuned on a fixed corpus, not measured optima. */
export const BRIEFING_LIMITS = {
  maxInputs: 40,
  /** Previously briefed families re-sent as comparison background, and previous highlights shown. */
  maxBackgroundFamilies: 12,
  maxComparisonHighlights: 8,
  /** Pending items carried forward at most (most recent first). */
  maxCarry: 200,
  baselineWindowDays: 14,
  maxContextTasks: 8,
  summaryChars: 600,
  excerptChars: 400,
  signalChars: 280,
  /** Hard bound on prompt + instruction characters of one Run, asserted before the Run is created. */
  promptChars: 48_000,
  runSeconds: 900,
  maxAttemptsPerVersion: 3,
  maxRunsPerScopePerDay: 6,
  historyLength: 20,
} as const;

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/** Content-addressed revision of a scope signal: changes when its label or text does. */
export function signalRevision(label: string, text: string | null): string {
  return sha256([label, text ?? ""]).slice(0, 16);
}

/** Identity of the exact request a Run sends: the frozen prompt and instruction. */
export function requestHash(prompt: string | null, instruction: string | null): string {
  return sha256([prompt ?? "", instruction ?? ""]);
}

export function signalKey(dep: Pick<BriefingSignalDep, "kind" | "id">): string {
  return `${dep.kind}:${dep.id}`;
}

export function contextSourceKey(source: BriefingContextEntry["source"]): string {
  return `${source.type}:${source.id}`;
}
