/**
 * Record identity for imported ambient sessions.
 *
 * Identity is `(imported session, record_key)` and sameness is the content
 * hash. The session is part of the key because a runtime's message ids are
 * only unique within a session — Codex replays `item-1`, `item-2`, … per
 * session — so a key alone would collide across sessions on the same machine.
 *
 * The hash covers content, not position. `sequence` is deliberately excluded:
 * a replay that inserts an earlier turn shifts every later one without any of
 * them having changed, and treating that as a conflict would report the whole
 * session as disagreeing every time a person used their own CLI.
 */

import { createHash } from "node:crypto";
import type { AmbientRecord } from "@rainver/protocol";

function canonicalPayload(record: AmbientRecord): string {
  return JSON.stringify([
    record.record_key,
    record.kind,
    record.text ?? null,
    record.tool_name ?? null,
    record.tool_status ?? null,
    record.tool_input ?? null,
    record.tool_output ?? null,
    record.raw_json ?? null,
  ]);
}

export function ambientRecordHash(record: AmbientRecord): string {
  return createHash("sha256").update(canonicalPayload(record)).digest("hex");
}
