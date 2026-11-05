import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import { insertArtifactRow } from "../artifacts/reviewArtifactWriter.js";
import type { Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import { DELEGATION_BRIEF_ARTIFACT_TYPE, RUN_ARTIFACT_URI_PREFIX } from "../sessions/conversationInputResourceService.js";

/**
 * A delegated task longer than this is not inlined. The threshold is a
 * routing choice, never a refusal: every Room delegation through 2026-11-05
 * written as an instruction fit in about 10,000 characters, and everything
 * longer carried pasted material (one review loop pasted 400,000-character
 * source snapshots). Measured on one deployment's use; revisit with more.
 */
export const DELEGATION_INLINE_INSTRUCTION_CHARS = 16_000;

/** How much of a stored task stays inline: where the ask normally is. */
const DELEGATION_BRIEF_HEAD_CHARS = 4_000;

/**
 * The task as handed to the child. An oversized one is stored whole as a
 * `delegation_brief` Artifact of the delegating Run, visible exactly where
 * that Run is (B8A), and the child receives its head plus the
 * `rainver://artifacts/<id>` link, which every Room child can read with
 * `input_resource.read/search` on any Host and under any isolation.
 *
 * Only in a Room conversation: there the child has the resource tools and the
 * link resolves (`sessions/conversationInputResourceService.ts`). Elsewhere
 * the task stays inline, and the runtime's input limit is the bound
 * (`runs/promptInputLimit.ts`).
 */
export async function handedOverInstruction(
  db: Queryable,
  input: {
    instruction: string;
    parentRun: Pick<RunRecord, "id" | "space_id" | "session_id" | "project_id" | "agent_id" | "visibility" | "instructed_by_user_id" | "owner_user_id">;
    inRoom: boolean;
    requestedByUserId: string;
    targetAgentId: string;
  },
): Promise<string> {
  const { instruction, parentRun } = input;
  if (instruction.length <= DELEGATION_INLINE_INSTRUCTION_CHARS || !input.inRoom || !parentRun.session_id) return instruction;
  const now = new Date().toISOString();
  const visibility = parentRun.visibility === "selected_users" ? "selected_users" : "private";
  const artifactId = await insertArtifactRow(db, {
    spaceId: parentRun.space_id,
    ownerUserId: parentRun.instructed_by_user_id ?? parentRun.owner_user_id ?? input.requestedByUserId,
    artifactType: DELEGATION_BRIEF_ARTIFACT_TYPE,
    title: `Delegated task for ${input.targetAgentId}`,
    content: instruction,
    metadata: { requesting_agent_id: parentRun.agent_id, target_agent_id: input.targetAgentId, characters: instruction.length },
    canonicalFormat: "text",
    mimeType: "text/plain; charset=utf-8",
    visibility,
    runId: parentRun.id,
    projectId: parentRun.project_id,
    createdAt: now,
    surfaceRole: "operational",
  });
  if (visibility === "selected_users") {
    await inheritContentAccessGrants(db, {
      spaceId: parentRun.space_id,
      sourceResourceType: "run",
      sourceResourceId: parentRun.id,
      targetResourceType: "artifact",
      targetResourceId: artifactId,
      inheritedAt: now,
    });
  }
  return [
    headOf(instruction, DELEGATION_BRIEF_HEAD_CHARS),
    `[This task is ${instruction.length} characters; only its beginning is above. The whole task is ${RUN_ARTIFACT_URI_PREFIX}${artifactId}: `
      + "read it with input_resource.read (resource_id is that link; continue while truncated is true) or search it with input_resource.search.]",
  ].join("\n\n");
}

/** The first `chars` UTF-16 units, never ending inside a surrogate pair. */
function headOf(text: string, chars: number): string {
  const code = text.charCodeAt(chars - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? chars - 1 : chars);
}
