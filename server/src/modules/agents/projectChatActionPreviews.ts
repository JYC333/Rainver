import type { Queryable } from "../routeUtils/common.js";
import { memoryProposalDecider } from "../memory/memoryProposalDecider.js";
import { OWNER_ONLY_PROPOSAL_TYPES } from "../ontology/entities.js";
import { digestCardSummary } from "../sources/gmail/gmailDigestProposal.js";
import { applicationUpdatesCardSummary } from "../sources/gmail/gmailApplicationUpdates.js";
import { GmailDigestProposalPayloadSchema } from "@rainver/protocol";
import { GMAIL_PRIVATE_READ_PROPOSAL, privateReadCardSummary } from "../sources/gmail/gmailPrivateReadHandoff.js";
import { GMAIL_PRIVATE_CHECK_PROPOSAL, privateCheckCardSummary } from "../sources/gmail/gmailPrivateCheck.js";

interface ProjectChatActionPreview {
  action_id: string;
  tool_call_id?: string | null;
  status: "proposed" | "auto_applied" | "completed" | "failed" | "rejected";
  /** Set when one named person decides this and nobody else may — see above. */
  decidable_by_user_id?: string | null;
  proposal_id?: string | null;
  proposal_type?: string | null;
  title?: string | null;
  summary?: string | null;
  risk_level?: string | null;
  scope?: Record<string, unknown> | null;
}

interface ProposalPreviewRow {
  id: string;
  proposal_type: string;
  title: string;
  status: string;
  risk_level: string;
  payload_json: Record<string, unknown>;
  /** Only for cards whose stored summary is what the owner decides on (ADR 0035). */
  summary?: string | null;
  action_idempotency_key: string | null;
  created_by_run_id: string;
  created_by_agent_id: string | null;
  owner_user_id: string | null;
  expired: boolean;
}

interface ActionEventRow {
  run_id: string;
  status: string;
  metadata_json: Record<string, unknown> | null;
}

/**
 * The cards a turn's proposals render as.
 *
 * A proposal only one person may decide — an Agent's persona, which is its
 * owner's alone by identity rather than by role
 * ([ADR 0003](../../../../.agent/decisions/0003-memory-proposal-flow.md) §5) —
 * carries `decidable_by_user_id`. Shared Room messages never persist those
 * previews: the Room read projection loads them from the proposal authority
 * for the current viewer. This keeps the proposed text out of a shared row
 * while still giving the owner the in-conversation decision card.
 */
export async function loadProjectChatActionPreviews(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<ProjectChatActionPreview[]> {
  return (await loadChatActionPreviewsByRunIds(db, spaceId, [runId])).get(runId) ?? [];
}

/** Two queries for a whole transcript page, rather than two per message. */
export async function loadChatActionPreviewsByRunIds(
  db: Queryable,
  spaceId: string,
  runIds: readonly string[],
): Promise<Map<string, ProjectChatActionPreview[]>> {
  const uniqueRunIds = [...new Set(runIds.filter(Boolean))];
  const byRun = new Map<string, ProjectChatActionPreview[]>(
    uniqueRunIds.map((runId) => [runId, []]),
  );
  if (uniqueRunIds.length === 0) return byRun;
  const [proposalRows, eventRows] = await Promise.all([
    db.query<ProposalPreviewRow>(
      `SELECT id, proposal_type, title, status, risk_level, payload_json,
              CASE WHEN proposal_type IN ('gmail_setup','gmail_read_delegation') THEN summary END AS summary,
              action_idempotency_key, created_by_run_id, created_by_agent_id, owner_user_id,
              (status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()) AS expired
         FROM proposals
        WHERE space_id = $1 AND created_by_run_id = ANY($2::varchar[])
        ORDER BY created_at`,
      [spaceId, uniqueRunIds],
    ),
    db.query<ActionEventRow>(
      `SELECT run_id, status, metadata_json
         FROM run_events
        WHERE space_id = $1 AND run_id = ANY($2::varchar[]) AND event_type = 'action_completed'
        ORDER BY run_id, event_index`,
      [spaceId, uniqueRunIds],
    ),
  ]);

  const proposalIds = new Set(proposalRows.rows.map(row => row.id));
  const proposalCallIds = new Map<string, Set<string>>();
  for (const row of proposalRows.rows) {
    // The same decider the accept path enforces, so the card offers the
    // decision to the one person who may make it.
    // An owner-only private draft (a Gmail monitor) is its owner's card alone, never
    // a shared snapshot, whoever else can read the Run.
    const decider = OWNER_ONLY_PROPOSAL_TYPES.includes(row.proposal_type)
      ? { required: true as const, userId: row.owner_user_id ?? "" }
      : await memoryProposalDecider(db, { space_id: spaceId, ...row });
    const callIds = proposalCallIds.get(row.created_by_run_id) ?? new Set<string>();
    if (row.action_idempotency_key) callIds.add(row.action_idempotency_key);
    proposalCallIds.set(row.created_by_run_id, callIds);
    // Withdrawn Gmail cards (ADR 0033 §6: the hand-off and the in-place private check) are history only:
    // never offered for a decision.
    const withdrawn = row.proposal_type === GMAIL_PRIVATE_READ_PROPOSAL || row.proposal_type === GMAIL_PRIVATE_CHECK_PROPOSAL;
    byRun.get(row.created_by_run_id)?.push({
      action_id: typeof row.payload_json?.action_id === "string" ? row.payload_json.action_id : row.proposal_type,
      tool_call_id: row.action_idempotency_key,
      // An expired Proposal stays `pending` but can no longer be decided: it is not offered.
      status: row.status === "pending" && !row.expired && !withdrawn ? "proposed" : row.status === "accepted" ? "auto_applied" : row.status === "rejected" ? "rejected" : "failed",
      proposal_id: row.id,
      proposal_type: row.proposal_type,
      title: row.title,
      // A Gmail digest's one confirmation card says what accepting allows (owner-only card, never shared).
      summary: row.proposal_type === "gmail_digest_create" ? gmailDigestSummary(row.payload_json)
        : row.proposal_type === GMAIL_PRIVATE_READ_PROPOSAL ? gmailPrivateReadSummary(row.payload_json)
        : row.proposal_type === GMAIL_PRIVATE_CHECK_PROPOSAL ? gmailPrivateCheckSummary(row.payload_json)
        // ADR 0035: the combined card and a read delegation show the summary they were drafted with.
        : row.proposal_type === "gmail_setup" || row.proposal_type === "gmail_read_delegation" ? (typeof row.summary === "string" ? row.summary : null) : null,
      risk_level: row.risk_level,
      scope: typeof row.payload_json?.project_id === "string" ? { project_id: row.payload_json.project_id } : null,
      decidable_by_user_id: decider.required ? decider.userId : null,
    });
  }
  for (const row of eventRows.rows) {
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    const actionId = typeof metadata.action_id === "string" ? metadata.action_id : null;
    const callId = typeof metadata.tool_call_id === "string" ? metadata.tool_call_id : null;
    // Canonical Run evidence also exists for legacy proposals without a call key.
    // The Proposal card owns decision authority; do not render a duplicate public card.
    if (typeof metadata.proposal_id === "string" && proposalIds.has(metadata.proposal_id)) continue;
    if (!actionId || (callId && proposalCallIds.get(row.run_id)?.has(callId))) continue;
    const failed = row.status === "failed" || metadata.ok === false;
    byRun.get(row.run_id)?.push({
      action_id: actionId,
      tool_call_id: callId,
      status: failed ? "failed" : "completed",
      // A completed action never carries this: it is a record of what ran, not
      // a decision anyone is waiting on.
      decidable_by_user_id: null,
      title: actionId,
      // The reason before the code: "No active Question Thread has id …" is
      // something a person can act on; "system_action_failed" is not.
      summary: !failed
        ? null
        : typeof metadata.error_message === "string" && metadata.error_message
          ? metadata.error_message
          : typeof metadata.error_code === "string" ? metadata.error_code : null,
      scope: null,
    });
  }
  return byRun;
}

/** The projection boundary for a preview whose decision authority is personal. */
export function actionPreviewsForViewer(
  previews: readonly ProjectChatActionPreview[],
  viewerUserId: string,
): ProjectChatActionPreview[] {
  return previews.filter((preview) =>
    !preview.decidable_by_user_id || preview.decidable_by_user_id === viewerUserId);
}

/**
 * `actionPreviewsForViewer` for a conversation read. Kept as the one entry point conversation reads use;
 * the withdrawn private Gmail check card (ADR 0033 §6) is owner-only history like any other owner card.
 */
export async function actionPreviewsForViewerChecked(
  _db: Queryable,
  _spaceId: string,
  previews: readonly ProjectChatActionPreview[],
  viewerUserId: string,
): Promise<ProjectChatActionPreview[]> {
  return actionPreviewsForViewer(previews, viewerUserId);
}

/** What is safe to snapshot into a message shared by every Room reader. */
export function sharedActionPreviews(
  previews: readonly ProjectChatActionPreview[],
): ProjectChatActionPreview[] {
  return previews.filter((preview) => !preview.decidable_by_user_id);
}

function gmailDigestSummary(payload: Record<string, unknown>): string | null {
  const text = (key: string) => typeof payload?.[key] === "string" ? payload[key] as string : null;
  const kind = text("kind"), mailbox = text("mailbox_email"), localTime = text("local_time"), timeZone = text("time_zone");
  const parsed = GmailDigestProposalPayloadSchema.safeParse(payload);
  // The audience and the execution configuration the card froze (ADR 0035 §1, §3), as its stored summary shows them.
  const audience = parsed.success ? parsed.data.audience ?? null : null;
  const binding = parsed.success ? parsed.data.runtime_binding ?? null : null;
  if (kind === "application") {
    return parsed.success && parsed.data.effects ? applicationUpdatesCardSummary({
      mailbox_email: parsed.data.mailbox_email, effects: parsed.data.effects, binding, audience, include_sent: parsed.data.include_sent,
    }) : null;
  }
  return mailbox && (kind === "rule" || (kind === "daily" && localTime && timeZone)) ? digestCardSummary({
    kind, mailbox_email: mailbox, local_time: localTime, time_zone: timeZone, shared: payload?.shared_conversation === true,
    ...(binding ? { agent_name: binding.agent_name, model_label: binding.model_label } : {}), audience,
  }) : null;
}

function gmailPrivateReadSummary(payload: Record<string, unknown>): string | null {
  const text = (key: string) => typeof payload?.[key] === "string" ? payload[key] as string : null;
  const mailbox = text("mailbox_email"), project = text("project_name"), request = text("request_text");
  return mailbox && project !== null && request ? privateReadCardSummary({ mailbox_email: mailbox, project_name: project, request_text: request }) : null;
}

function gmailPrivateCheckSummary(payload: Record<string, unknown>): string | null {
  const text = (key: string) => typeof payload?.[key] === "string" ? payload[key] as string : null;
  const mailbox = text("mailbox_email"), project = text("project_name");
  return mailbox && project !== null ? privateCheckCardSummary({ mailbox_email: mailbox, project_name: project }) : null;
}
