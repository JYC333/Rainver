import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect } from "vitest";
import { currentRuntimeContextInputRef } from "../../src/modules/runs/orchestrationService.js";
import type { RunRecord } from "../../src/modules/runs/repository.js";
import type { SyntheticAcpHost, SyntheticAcpPrompt } from "./syntheticAcpHost.js";

interface PersistedBlock {
  semantic_role: string;
  source_item_ids: string[];
  content_hash: string;
}

/**
 * One physical invocation seen from its three records: the canonical current
 * input, the immutable Delivery and Invocation Snapshot the Gateway persisted
 * for it, and the ACP prompt the Host actually received.
 */
export interface JoinedInvocation {
  run: RunRecord;
  current: { ref: { type: string; id: string }; text: string };
  delivery: { id: string; attempt: number; blocks: PersistedBlock[] };
  snapshot: { id: string; status: string; sourceRefs: Array<{ type: string; id: string }> };
  acp: SyntheticAcpPrompt;
  /** Each Delivery block's content, recovered from the ACP prompt in Delivery order. */
  deliveredContents: string[];
  /** The current-user block's content as the runtime read it. */
  currentUserContent: string;
  /** Text blocks the adapter appended after the Delivery (work-surface guidance and the like). */
  supplementalText: string[];
  /** Non-text blocks: hydrated attachments and Skill links. */
  attachments: Array<Record<string, unknown>>;
  /** Every text block of the ACP prompt, joined. */
  text: string;
}

/** `invocationSnapshotService.ts` hashes a block's content as stable JSON. */
function contentHash(content: string): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (!needle) throw new Error("occurrences() needs a non-empty needle");
  return haystack.split(needle).length - 1;
}

/** How `acpRuntimeContextPrompt.ts` groups consecutive Delivery blocks under one label. */
function sectionKey(block: PersistedBlock, index: number, currentUserIndex: number): string {
  if (block.semantic_role === "user_input") return index === currentUserIndex ? "current_user" : "prior_user";
  if (block.semantic_role === "delegated_instruction") return "instructions";
  if (block.semantic_role === "reference_data") return "reference";
  return "prior_user";
}

/**
 * Splits a labelled section body back into its Delivery blocks: the adapter
 * joins one section's blocks with a blank line, and each part must hash to
 * the persisted block in order — so nothing is lost, duplicated or moved.
 */
function splitSection(body: string, hashes: readonly string[]): string[] | null {
  if (hashes.length === 0) return body === "" ? [] : null;
  if (hashes.length === 1) return contentHash(body) === hashes[0] ? [body] : null;
  for (let at = body.indexOf("\n\n"); at >= 0; at = body.indexOf("\n\n", at + 1)) {
    const head = body.slice(0, at);
    if (contentHash(head) !== hashes[0]) continue;
    const rest = splitSection(body.slice(at + 2), hashes.slice(1));
    if (rest) return [head, ...rest];
  }
  return null;
}

/**
 * Loads one Run's latest invocation and asserts the joined contract: the
 * Snapshot names the same Delivery and exactly one canonical current input,
 * the Host received exactly one prompt for this attempt, and that prompt's
 * text sections reproduce every persisted Delivery block exactly once and in
 * order, with the current input last among them.
 */
export async function joinedInvocation(pool: Pool, host: SyntheticAcpHost, runId: string): Promise<JoinedInvocation> {
  const run = (await pool.query<RunRecord>(`SELECT * FROM runs WHERE id = $1`, [runId])).rows[0];
  if (!run) throw new Error(`Run ${runId} not found`);
  const ref = currentRuntimeContextInputRef(run);
  const text = ref.type === "message"
    ? (await pool.query<{ content: string }>(`SELECT content FROM messages WHERE id = $1 AND space_id = $2`, [ref.id, run.space_id])).rows[0]?.content
    : run.prompt;
  if (typeof text !== "string") throw new Error(`Run ${runId} has no canonical current input`);

  const delivery = (await pool.query<{ id: string; attempt: number; delivery_metadata_json: { message_blocks: PersistedBlock[]; audit_refs: Record<string, string> } }>(
    `SELECT id, attempt, delivery_metadata_json FROM invocation_deliveries
      WHERE space_id = $1 AND invocation_id = $2 ORDER BY attempt DESC LIMIT 1`,
    [run.space_id, run.id],
  )).rows[0];
  if (!delivery) throw new Error(`Run ${runId} has no Invocation Delivery`);
  const snapshot = (await pool.query<{ id: string; status: string; invocation_id: string; attempt: number; safe_snapshot_json: { delivery_id: string; source_refs: Array<{ type: string; id: string }> } }>(
    `SELECT id, status, invocation_id, attempt, safe_snapshot_json FROM invocation_snapshots WHERE delivery_id = $1`,
    [delivery.id],
  )).rows[0];
  if (!snapshot) throw new Error(`Delivery ${delivery.id} has no Invocation Snapshot`);
  expect(snapshot).toMatchObject({ invocation_id: run.id, attempt: delivery.attempt, status: "finalized" });
  expect(snapshot.safe_snapshot_json.delivery_id).toBe(delivery.id);
  expect(delivery.delivery_metadata_json.audit_refs.invocation_snapshot_id).toBe(snapshot.id);
  const sourceRefs = snapshot.safe_snapshot_json.source_refs;
  expect(sourceRefs.filter((source) => source.type === ref.type && source.id === ref.id)).toHaveLength(1);

  // A Delivery is never reused for a second physical call (one prompt per attempt).
  const prompts = host.promptsFor(run.id);
  expect(prompts.length).toBe(delivery.attempt);
  const acp = prompts.at(-1)!;
  const textBlocks = acp.prompt.flatMap((block) => block.type === "text" ? [String(block.text)] : []);
  const attachments = acp.prompt.filter((block) => block.type !== "text");
  // The adapter emits text before attachments and Skill links.
  expect(acp.prompt.slice(0, textBlocks.length).every((block) => block.type === "text")).toBe(true);

  const blocks = delivery.delivery_metadata_json.message_blocks;
  const currentUserIndex = blocks.map((block) => block.semantic_role).lastIndexOf("user_input");
  expect(currentUserIndex).toBe(blocks.length - 1);
  let deliveredContents: string[];
  let consumed: number;
  if (blocks.length === 1) {
    // A lone current message is sent verbatim.
    deliveredContents = [textBlocks[0] ?? ""];
    expect(contentHash(deliveredContents[0]!)).toBe(blocks[0]!.content_hash);
    consumed = 1;
  } else {
    // A channel notice, then one labelled text block per run of same-section blocks.
    const sections: Array<{ hashes: string[] }> = [];
    let previous: string | null = null;
    for (const [index, block] of blocks.entries()) {
      const key = sectionKey(block, index, currentUserIndex);
      if (key !== previous) sections.push({ hashes: [] });
      sections.at(-1)!.hashes.push(block.content_hash);
      previous = key;
    }
    deliveredContents = [];
    for (const [index, section] of sections.entries()) {
      const labelled = textBlocks[index + 1] ?? "";
      expect(labelled.startsWith("## ")).toBe(true);
      const parts = splitSection(labelled.slice(labelled.indexOf("\n") + 1), section.hashes);
      expect(parts, `ACP section ${index} does not reproduce its Delivery blocks`).not.toBeNull();
      deliveredContents.push(...parts!);
    }
    consumed = sections.length + 1;
  }
  const currentUserContent = deliveredContents.at(-1)!;
  const joined = textBlocks.join("\n");
  // The canonical current input reaches the runtime exactly once, as the current block.
  if (text) {
    expect(currentUserContent.startsWith(text)).toBe(true);
    expect(occurrences(joined, text)).toBe(1);
  }
  return {
    run,
    current: { ref, text },
    delivery: { id: delivery.id, attempt: delivery.attempt, blocks },
    snapshot: { id: snapshot.id, status: snapshot.status, sourceRefs },
    acp,
    deliveredContents,
    currentUserContent,
    supplementalText: textBlocks.slice(consumed),
    attachments,
    text: joined,
  };
}
