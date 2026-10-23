import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";
import { SubscriptionQuotaHoldSchema, SubscriptionUsageLineSchema } from "./subscriptionQuota.js";

/**
 * A bounded discussion among the Agents of one Room conversation.
 *
 * It lives in the conversation's single timeline: every message inside it
 * carries `discussion_id`, and the client folds them into one block. A wave is
 * one dispatch — the message that started it and the replies of its
 * recipients — and waves are numbered from the person's message (0). A
 * discussion is charged to the person whose message opened it (its container)
 * and ends by convergence (a wave in which nobody addresses anyone), by its
 * round or spend cap, or by a person stopping it; the Room's Manager then
 * writes the conclusion.
 */
export const RoomDiscussionKindSchema = z.enum(["emergent", "explicit"]);
export type RoomDiscussionKind = z.infer<typeof RoomDiscussionKindSchema>;

/** `debate`: the first round answers independently; later rounds critique. */
export const RoomDiscussionShapeSchema = z.enum(["open", "debate"]);
export type RoomDiscussionShape = z.infer<typeof RoomDiscussionShapeSchema>;

export const RoomDiscussionStatusSchema = z.enum(["active", "converged", "cap_reached", "stopped", "closed"]);
export type RoomDiscussionStatus = z.infer<typeof RoomDiscussionStatusSchema>;

/** Rounds a discussion runs when the person opening it names none. */
export const ROOM_DISCUSSION_DEFAULT_ROUND_CAP = { open: 3, debate: 2 } as const;
/**
 * The spend a discussion may reach on priced Runs when the person opening it
 * sets none (ADR 0017 §3: bounded, then asked). Subscription Runs are bounded
 * by rounds and by the account's own window instead.
 */
export const ROOM_DISCUSSION_DEFAULT_SPEND_CAP_USD = 2;
/** Upper bound on rounds requested or added in one call. */
export const ROOM_DISCUSSION_MAX_ROUNDS = 10;
/** Agents one discussion may seat: the per-turn fan-out ceiling (ADR 0017). */
export const ROOM_DISCUSSION_MAX_PARTICIPANTS = 5;

/** An Agent that was addressed but held back, and who addressed it. */
export const RoomDiscussionHeldMentionSchema = z.object({
  agent_id: IdSchema,
  from_agent_ids: z.array(IdSchema),
  content: z.string(),
}).strict();
export type RoomDiscussionHeldMention = z.infer<typeof RoomDiscussionHeldMentionSchema>;

export const RoomDiscussionSchema = z.object({
  id: IdSchema,
  room_id: IdSchema,
  session_id: IdSchema,
  kind: RoomDiscussionKindSchema,
  shape: RoomDiscussionShapeSchema,
  status: RoomDiscussionStatusSchema,
  stop_reason: z.string().nullable(),
  topic: z.string().nullable(),
  opened_by_user_id: IdSchema,
  origin_message_id: IdSchema,
  participant_agent_ids: z.array(IdSchema),
  round_cap: z.number().int().positive(),
  rounds_used: z.number().int().nonnegative(),
  /** The wave of the latest person's message: rounds count from it. */
  round_base: z.number().int().nonnegative(),
  /** Agent-triggered turns charged so far, against the fan-out ceiling. */
  turns_used: z.number().int().nonnegative(),
  spend_cap_usd: z.number().nonnegative().nullable(),
  spend_usd: z.number().nonnegative(),
  held_mentions: z.array(RoomDiscussionHeldMentionSchema),
  conclusion_message_id: IdSchema.nullable(),
  /** Who chose to continue past the subscription reserve line, if anyone. */
  quota_override_by_user_id: IdSchema.nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
  ...SecretResponseGuards,
}).strict();
export type RoomDiscussion = z.infer<typeof RoomDiscussionSchema>;

export const RoomDiscussionWaveSchema = z.object({
  wave: z.number().int().nonnegative(),
  group_id: IdSchema,
  trigger_message_id: IdSchema,
  run_ids: z.array(IdSchema),
  closing: z.boolean(),
}).strict();
export type RoomDiscussionWave = z.infer<typeof RoomDiscussionWaveSchema>;

export const RoomDiscussionDetailSchema = z.object({
  discussion: RoomDiscussionSchema,
  waves: z.array(RoomDiscussionWaveSchema),
  /**
   * What the discussion cost, one line per funding source: money on priced
   * Runs, and per subscription its tokens here with the account's window
   * (the percentage is account-wide and cannot be attributed to it).
   */
  usage: z.object({
    priced_usd: z.number().nonnegative(),
    subscription: z.array(SubscriptionUsageLineSchema),
  }).strict(),
  /** Agent-triggered turns of this discussion held at the subscription reserve line, if any. */
  quota_hold: SubscriptionQuotaHoldSchema.nullable(),
  ...SecretResponseGuards,
}).strict();
export type RoomDiscussionDetail = z.infer<typeof RoomDiscussionDetailSchema>;

export const RoomDiscussionListResponseSchema = z.object({
  items: z.array(RoomDiscussionSchema),
  ...SecretResponseGuards,
}).strict();
export type RoomDiscussionListResponse = z.infer<typeof RoomDiscussionListResponseSchema>;

export const OpenRoomDiscussionRequestSchema = z.object({
  topic: z.string().trim().min(1).max(8000),
  /** Explicit Agents, or every active Agent of the Room (refused above the ceiling). */
  participant_agent_ids: z.union([z.array(IdSchema).min(1).max(ROOM_DISCUSSION_MAX_PARTICIPANTS), z.literal("all")]),
  shape: RoomDiscussionShapeSchema.default("open"),
  round_cap: z.number().int().min(1).max(ROOM_DISCUSSION_MAX_ROUNDS).optional(),
  spend_cap_usd: z.number().positive().max(1000).optional(),
}).strict();
export type OpenRoomDiscussionRequest = z.infer<typeof OpenRoomDiscussionRequestSchema>;

export const ExtendRoomDiscussionRequestSchema = z.object({
  rounds: z.number().int().min(1).max(ROOM_DISCUSSION_MAX_ROUNDS),
}).strict();
export type ExtendRoomDiscussionRequest = z.infer<typeof ExtendRoomDiscussionRequestSchema>;

/**
 * What a discussion notice in the transcript is about. `cap_reached` offers
 * more rounds (its reason `quota_exhausted` when a vendor CLI refused for an
 * exhausted subscription); `not_admitted` names an Agent that was addressed
 * and cannot be triggered by the container's owner (an owner-only specialist,
 * an unshared private Agent); `failed` says the discussion could not continue
 * and ended; `quota_hold` says its Agent-triggered turns wait for a
 * subscription window past the Space's reserve line. `resets_at` is that
 * window's reset time, when known.
 */
export const RoomDiscussionNoticeSchema = z.object({
  discussion_id: IdSchema,
  kind: z.enum(["cap_reached", "not_admitted", "failed", "quota_hold"]),
  reason: z.string(),
  agent_ids: z.array(IdSchema),
  resets_at: ISODateTimeSchema.nullable().optional(),
}).strict();
export type RoomDiscussionNotice = z.infer<typeof RoomDiscussionNoticeSchema>;

// ---------------------------------------------------------------------------
// Addressing an Agent in text
// ---------------------------------------------------------------------------

/**
 * A message as the recipient router sees it: text runs and mentioned Agents.
 * The composer builds these from its editor; an Agent's reply is parsed into
 * them by `parseAgentMentions`. Both then segment the same way.
 */
export type AgentMentionToken =
  | { type: "text"; text: string }
  | { type: "mention"; id: string; label: string };

export interface AgentMentionSegment {
  recipient_agent_ids: string[];
  content: string;
}

export interface AgentMentionRosterEntry {
  agent_id: string;
  label: string;
}

/**
 * Where a person's message goes when nobody overrides it. `null`: it names
 * nobody, so it goes to the Room's manager like any unaddressed message.
 */
export type AgentMentionDefaultRoute = "direct" | "agent_coordination" | null;

/**
 * How the mentions of one message route it.
 *
 * Adjacent mentions form one cluster. A cluster is an **address** only when
 * it opens the message or a line — nothing but whitespace (and list or quote
 * markers) before it on that line; any other mention is a **reference** to an
 * Agent the message talks about. A message with an address goes directly to
 * the addressed Agents; one whose mentions are all references goes to the
 * manager, who is asked to arrange the work with the referenced Agents.
 */
export interface AgentMentionRoute {
  default_route: AgentMentionDefaultRoute;
  /** Every mentioned Agent, addresses and references, in order. */
  mentioned_agent_ids: string[];
  /** Agents addressed by a cluster that opens the message or a line. */
  addressed_agent_ids: string[];
  /**
   * What a direct send delivers: the address clusters' segments, or — when
   * the person chose direct for a message with only references — one
   * segment per mention cluster.
   */
  direct_segments: AgentMentionSegment[];
  /** A stable key of the mentions and their roles; a route choice holds while it is unchanged. */
  key: string;
}

export function agentMentionRoute(tokens: readonly AgentMentionToken[]): AgentMentionRoute {
  const clusters = mentionClusters(tokens);
  const addresses = clusters.filter((cluster) => cluster.address);
  return {
    default_route: clusters.length === 0 ? null : addresses.length > 0 ? "direct" : "agent_coordination",
    mentioned_agent_ids: uniqueAgentIds(clusters.flatMap((cluster) => cluster.recipient_agent_ids)),
    addressed_agent_ids: uniqueAgentIds(addresses.flatMap((cluster) => cluster.recipient_agent_ids)),
    direct_segments: segmentsForClusters(tokens, addresses.length > 0 ? addresses : clusters),
    key: clusters
      .map((cluster) => `${cluster.address ? "a" : "r"}:${cluster.recipient_agent_ids.join(",")}`)
      .join("|"),
  };
}

/**
 * Who a message addresses, and what it says to each.
 *
 * Only address clusters (see `AgentMentionRoute`) route a segment; with
 * `include: "all"` every cluster does, which is what a person's explicit
 * choice of a direct send means for a message of references. With one
 * routed cluster the whole message is its content; with several, each gets
 * the text from its own mentions to the next routed cluster, and the first
 * also gets whatever came before it. Mentions stay in the content, so the
 * recipient reads the message as it was written.
 */
export function agentMentionSegments(
  tokens: readonly AgentMentionToken[],
  options: { include?: "addresses" | "all" } = {},
): AgentMentionSegment[] {
  const clusters = mentionClusters(tokens);
  return segmentsForClusters(tokens, options.include === "all" ? clusters : clusters.filter((cluster) => cluster.address));
}

function segmentsForClusters(tokens: readonly AgentMentionToken[], clusters: readonly MentionCluster[]): AgentMentionSegment[] {
  return clusters.map((cluster, index) => {
    const next = clusters[index + 1] ?? null;
    const from = index === 0 ? 0 : cluster.start;
    const content = normalizeMentionText(renderMentionTokens(tokens.slice(from, next?.start ?? tokens.length), true));
    return { recipient_agent_ids: cluster.recipient_agent_ids, content };
  });
}

/** Render tokens back to text; mentions as `@label` when kept. */
export function renderMentionTokens(tokens: readonly AgentMentionToken[], includeMentions: boolean): string {
  return tokens.map((token) => token.type === "text"
    ? token.text
    : includeMentions ? `@${token.label}` : "").join("");
}

export function normalizeMentionText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Parse `@Label` mentions of roster Agents out of plain text — an Agent's
 * reply — into tokens. Labels match case-insensitively, longest first, and
 * only where the `@` starts a word and the label ends one (a CJK character on
 * either side counts as a word edge). Code (fenced blocks and inline spans) is
 * never read as mentioning anyone.
 *
 * `segments` holds only the address clusters — a mention that opens the reply
 * or a line. A mention inside a sentence (an explanation, a quote, an
 * example) is a reference and addresses nobody.
 */
export function parseAgentMentions(
  text: string,
  roster: readonly AgentMentionRosterEntry[],
): {
  tokens: AgentMentionToken[];
  segments: AgentMentionSegment[];
  mentioned_agent_ids: string[];
  addressed_agent_ids: string[];
} {
  const entries = roster
    .filter((entry) => entry.label.trim().length > 0)
    .map((entry) => ({ ...entry, lower: entry.label.trim().toLowerCase() }))
    .sort((left, right) => right.lower.length - left.lower.length);
  const tokens: AgentMentionToken[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) tokens.push({ type: "text", text: buffer });
    buffer = "";
  };
  const code = codeRanges(text);
  let index = 0;
  while (index < text.length) {
    const inCode = code.find((range) => index >= range.start && index < range.end);
    if (inCode) {
      buffer += text.slice(index, inCode.end);
      index = inCode.end;
      continue;
    }
    const character = text[index]!;
    if (character === "@" && (index === 0 || isWordBoundary(text[index - 1]!, text[index + 1] ?? " "))) {
      // Compared on the original text, a label's length at a time: lowercasing
      // the rest first can change its length (`İ`) and shift every position.
      const match = entries.find((entry) => {
        const length = entry.label.trim().length;
        return text.slice(index + 1, index + 1 + length).toLowerCase() === entry.lower
          && isWordBoundary(text[index + length]!, text[index + 1 + length] ?? " ");
      });
      if (match) {
        flush();
        tokens.push({ type: "mention", id: match.agent_id, label: match.label.trim() });
        index += 1 + match.label.trim().length;
        continue;
      }
    }
    buffer += character;
    index += 1;
  }
  flush();
  const route = agentMentionRoute(tokens);
  return {
    tokens,
    segments: agentMentionSegments(tokens),
    mentioned_agent_ids: route.mentioned_agent_ids,
    addressed_agent_ids: route.addressed_agent_ids,
  };
}

interface MentionCluster {
  start: number;
  end: number;
  recipient_agent_ids: string[];
  /** Opens the message or a line: an address rather than a reference. */
  address: boolean;
}

/**
 * Whitespace and list markers (`-`, `*`, `+`, `1.`, `1)`) only. A quoted line
 * (`>`) reproduces someone's words, so a mention opening it is a reference.
 */
const LINE_OPENING = /^[ \t\u3000]*(?:(?:[-*+\u2022]|\d{1,9}[.)])[ \t\u3000]+)*$/;

/** Whether the tokens before `index` leave it at the start of a line. */
function opensLine(tokens: readonly AgentMentionToken[], index: number): boolean {
  let prefix = "";
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor]!;
    if (token.type === "mention") return false;
    const newline = token.text.lastIndexOf("\n");
    if (newline >= 0) {
      prefix = token.text.slice(newline + 1) + prefix;
      break;
    }
    prefix = token.text + prefix;
  }
  return LINE_OPENING.test(prefix);
}

function uniqueAgentIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function mentionClusters(tokens: readonly AgentMentionToken[]): MentionCluster[] {
  const clusters: MentionCluster[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token?.type !== "mention") {
      index += 1;
      continue;
    }
    const recipients = [token.id];
    const start = index;
    let end = index + 1;
    let cursor = end;
    while (cursor < tokens.length) {
      let next = cursor;
      // Mentions join one cluster only on the same line: each line is
      // judged on its own, so a reference cannot absorb the next line's address.
      let lineBreak = false;
      while (tokens[next]?.type === "text") {
        const textToken = tokens[next] as Extract<AgentMentionToken, { type: "text" }>;
        if (textToken.text.trim().length > 0) break;
        if (textToken.text.includes("\n")) lineBreak = true;
        next += 1;
      }
      if (lineBreak) break;
      const candidate = tokens[next];
      if (candidate?.type !== "mention") break;
      recipients.push(candidate.id);
      cursor = next + 1;
      end = cursor;
    }
    clusters.push({ start, end, recipient_agent_ids: uniqueAgentIds(recipients), address: opensLine(tokens, start) });
    index = end;
  }
  return clusters;
}

function codeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  for (const match of text.matchAll(pattern)) {
    ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return ranges;
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

/**
 * Whether a word may end between `before` and `after`. Scripts written without
 * spaces (Chinese, Japanese, and Korean particles that attach to a name) put a
 * mention directly against the surrounding text, so a character from one of
 * them is a boundary on either side; elsewhere two word characters are one word.
 */
function isWordBoundary(before: string, after: string): boolean {
  return !isWordCharacter(before) || !isWordCharacter(after) || isUnspacedScript(before) || isUnspacedScript(after);
}

function isUnspacedScript(character: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character);
}
