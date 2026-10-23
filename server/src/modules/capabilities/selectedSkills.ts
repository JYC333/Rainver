import { ConversationInputSkillPartSchema, type SkillPackageContent } from "@rainver/protocol";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import { lockSkillPackage, resolveSkillBindingsForScopes } from "./skillBindings.js";
import { loadSkillPackageContent } from "./skillPackageContent.js";

type SkillScope = { space_id: string; project_id: string | null; agent_id: string | null; user_id: string | null; session_id?: string | null };

/** Person and conversation a turn's Skill selection is checked for. */
export interface SelectedSkillTurnScope {
  space_id: string;
  project_id: string | null;
  /** Whose bindings govern the selection: the message author. */
  user_id: string | null;
  /** Whose Work Context setup supplies the Project override: the dispatcher (defaults to `user_id`). */
  setup_user_id?: string | null;
  session_id?: string | null;
}

/** A selected package verified once for a turn. */
export interface VerifiedSkillSelection { skill_package_id: string; package_hash: string; package_name: string }

/** Admission/menu use the same optional Project override as execution control. */
export async function conversationSkillScope(db: Queryable, scope: SkillScope): Promise<SkillScope> {
  const [resolved] = await conversationSkillScopes(db, scope, [scope.agent_id]);
  return { ...scope, project_id: resolved!.project_id };
}

/**
 * The effective Project for each Agent of a conversation in one query: a
 * person's Work Context setup for the direct session or the Room recipient
 * overrides the base Project, as execution control does.
 */
export async function conversationSkillScopes(
  db: Queryable, base: SelectedSkillTurnScope, agentIds: ReadonlyArray<string | null>,
): Promise<Array<{ project_id: string | null; agent_id: string | null }>> {
  const setupUser = base.setup_user_id ?? base.user_id;
  if (!base.session_id || !setupUser) return agentIds.map(agent_id => ({ project_id: base.project_id, agent_id }));
  const rows = (await db.query<{ scope_index: number; project_id: string | null }>(`SELECT target.ordinality::int AS scope_index,
      COALESCE((SELECT setup.project_id FROM work_context_setups setup
        WHERE setup.space_id=$1 AND setup.user_id=$2 AND setup.work_context_scope_id IN (
          SELECT id FROM sessions WHERE space_id=$1 AND id=$3 AND room_id IS NULL
          UNION ALL
          SELECT recipient.id FROM room_conversation_recipients recipient
          JOIN room_agent_members member ON member.id=recipient.room_agent_member_id AND member.space_id=recipient.space_id
          WHERE recipient.space_id=$1 AND recipient.session_id=$3 AND member.agent_id=target.agent_id
        ) ORDER BY setup.version DESC LIMIT 1), $5) AS project_id
    FROM unnest($4::varchar[]) WITH ORDINALITY AS target(agent_id, ordinality)`,
  [base.space_id, setupUser, base.session_id, [...agentIds], base.project_id])).rows;
  const projects = new Map(rows.map(row => [row.scope_index, row.project_id]));
  return agentIds.map((agent_id, index) => ({ project_id: projects.get(index + 1) ?? base.project_id, agent_id }));
}

function selectedSkillParts(parts: readonly { kind: string }[]) {
  return parts.filter(part => part.kind === "skill").map(part => {
    const parsed = ConversationInputSkillPartSchema.safeParse(part);
    if (!parsed.success) throw new HttpError(422, "Invalid selected Skill reference");
    return parsed.data;
  });
}

/**
 * Turn admission for selected Skills. Every addressed recipient must have an
 * effective binding for every selection under the author's bindings (one
 * query for all recipients), and each package's complete original bytes are
 * verified once per turn rather than once per recipient. The returned map
 * lets message preparation reuse that verification. Delivery re-validates
 * live bindings and bytes independently (`loadSelectedSkills`).
 */
export async function assertSelectedSkillsForRecipients(
  db: Queryable, scope: SelectedSkillTurnScope, agentIds: ReadonlyArray<string | null>, parts: readonly { kind: string }[],
): Promise<Map<string, VerifiedSkillSelection>> {
  const selected = selectedSkillParts(parts);
  const verified = new Map<string, VerifiedSkillSelection>();
  if (!selected.length) return verified;
  if (!scope.user_id) throw new HttpError(422, "Selected Skills have no message author");
  const recipients = agentIds.length ? [...new Set(agentIds)] : [null];
  const scopes = await conversationSkillScopes(db, scope, recipients);
  const bindings = await resolveSkillBindingsForScopes(db, scope.space_id, scope.user_id, scopes);
  const missing = recipients.filter((_agentId, index) => selected.some(part =>
    !bindings[index]!.some(binding => binding.skill_package_id === part.skill_package_id)));
  if (missing.length) {
    const detail = "Selected Skill is not enabled for every addressed Agent";
    throw new HttpError(422, detail, { detail, code: "selected_skill_not_enabled", agent_ids: missing.filter(Boolean) });
  }
  for (const part of selected) {
    if (verified.has(part.skill_package_id)) continue;
    const pkg = await loadSkillPackageContent(db, scope.space_id, part.skill_package_id);
    if (pkg.package_hash !== part.package_hash) throw new HttpError(409, "Selected Skill version changed");
    verified.set(pkg.skill_package_id, { skill_package_id: pkg.skill_package_id, package_hash: pkg.package_hash, package_name: pkg.package_name });
  }
  return verified;
}

/** Single-recipient admission (direct conversations). */
export async function assertSelectedSkillBindings(db: Queryable, scope: SkillScope, parts: readonly { kind: string }[]): Promise<void> {
  await assertSelectedSkillsForRecipients(db, scope, [scope.agent_id], parts);
}

/**
 * The current message's selected Skills for delivery. Selections are read
 * for the message whoever the viewer is (a Room member may retry another
 * member's turn), so they always match the rendered
 * `loadConversationSkillDescriptors`. The viewer must be able to read the
 * conversation; the message author's bindings govern, so a retry delivers
 * the author's selection only while it is still enabled for this Agent, and
 * otherwise fails closed.
 */
export async function loadSelectedSkills(db: Queryable, input: {
  space_id: string; project_id: string | null; agent_id: string | null; user_id: string | null;
  session_id: string | null; message_id: string | null; lock?: boolean;
}): Promise<Array<{ binding_id: string; content: SkillPackageContent }>> {
  if (!input.message_id || !input.session_id || !input.user_id) return [];
  const refs = (await db.query<{ skill_package_id: string; sha256: string; author_user_id: string | null; viewer_can_read: boolean }>(`
    SELECT part.skill_package_id,part.sha256,message.user_id AS author_user_id,
      ((session.room_id IS NULL AND session.user_id=$4) OR EXISTS (
        SELECT 1 FROM room_user_members member WHERE member.room_id=session.room_id
          AND member.space_id=session.space_id AND member.user_id=$4 AND member.status='active')) AS viewer_can_read
    FROM message_input_parts part
    JOIN messages message ON message.id=part.message_id AND message.space_id=part.space_id
    JOIN sessions session ON session.id=message.session_id AND session.space_id=message.space_id
    WHERE part.space_id=$1 AND part.message_id=$2 AND part.session_id=$3 AND part.kind='skill'
      AND message.role='user'
    ORDER BY part.position`, [input.space_id, input.message_id, input.session_id, input.user_id])).rows;
  if (!refs.length) return [];
  if (refs.length > 4) throw new HttpError(422, "Too many selected Skills");
  if (refs.some(ref => !ref.viewer_can_read)) throw new HttpError(404, "Selected Skill message is not available");
  const author = refs[0]!.author_user_id;
  if (!author) throw new HttpError(422, "Selected Skills have no message author");
  if (input.lock) {
    for (const id of refs.map(ref => ref.skill_package_id).sort()) {
      await lockSkillPackage(db, input.space_id, id);
    }
  }
  const [bindings] = await resolveSkillBindingsForScopes(db, input.space_id, author, [input]);
  const selected: Array<{ binding_id: string; content: SkillPackageContent }> = [];
  for (const ref of refs) {
    const binding = bindings!.find(binding => binding.skill_package_id === ref.skill_package_id);
    if (!binding) throw new HttpError(422, "Selected Skill is not enabled for this message's author, Project or Agent");
    const content = await loadSkillPackageContent(db, input.space_id, ref.skill_package_id);
    if (content.package_hash !== ref.sha256) throw new HttpError(409, "Selected Skill version no longer matches its message");
    selected.push({ binding_id: binding.id, content });
  }
  return selected;
}

export function selectedSkillInstruction(content: SkillPackageContent): string {
  return `The user explicitly selected Skill ${JSON.stringify(content.package_name)} (package ${content.skill_package_id}, SHA-256 ${content.package_hash}).\n`
    + `Read the attached Skill resource link named ${JSON.stringify(content.package_name)} and follow its original SKILL.md instructions for this request. Resolve supporting files relative to that file's directory.\n`
    + "This selection grants no additional tools, network, credentials, dependency installation, hooks or script execution permissions. Vendor-specific hooks and automatic commands are not installed.";
}
