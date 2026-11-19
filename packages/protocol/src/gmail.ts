import {z} from 'zod';

/**
 * Personal read-only Gmail connection contracts (`.agent/modules/sources.md`, "Personal Gmail connections").
 * Owner-only: no DTO carries a token, an authorization code, the
 * OAuth client secret, the Google subject or the credential generation.
 */
const id=z.string().trim().min(1).max(36);

export const GmailConnectionStatusSchema=z.enum(['active','reauth_required','disconnected']);
/**
 * Rainver never revokes a Google grant automatically: Google revokes per grant
 * (client + account), so one revoke could also cut another Space's connection of
 * the same account or a newer attempt's tokens. A disconnect removes local
 * authority only; the person revokes Rainver's access on this Google Account page.
 */
export const GMAIL_MANUAL_REVOCATION_URL='https://myaccount.google.com/connections' as const;
export const GmailErrorClassSchema=z.enum(['transient','invalid_grant','scope','uncertain']);

/**
 * One owner consent: an Agent may read this mailbox on request in the owner's
 * own turns in any ordinary conversation of one Project (their private chat, a
 * Room or the mainline) whose readers all read that Project, until revoked
 * (ADR 0033 §6). Revoked with
 * `plugin_data_grant.revoke`. `project_name` is null when the owner no longer
 * reads that Project.
 */
export const GmailAgentReadGrantSchema=z.object({
  grant_id:id,project_id:id,project_name:z.string().max(512).nullable(),purpose:z.literal('on_demand_read'),
  created_at:z.string().datetime({offset:true}),last_used_at:z.string().datetime({offset:true}).nullable(),
}).strict();
export type GmailAgentReadGrant=z.infer<typeof GmailAgentReadGrantSchema>;
export const GmailConnectionSchema=z.object({
  id,
  mailbox_email:z.string().max(320),
  status:GmailConnectionStatusSchema,
  granted_scopes:z.array(z.string().max(256)).max(16),
  last_error_class:GmailErrorClassSchema.nullable(),
  connected_at:z.string().datetime({offset:true}),
  disconnected_at:z.string().datetime({offset:true}).nullable(),
  /** The owner's switch that Project conversations (their private one, a Room, the mainline) may offer an Agent the mail read (ADR 0032/0033 §6). */
  agent_read_enabled:z.boolean(),
  /** The owner's standing Project consents on this connection (ADR 0033); content-free. */
  agent_read_grants:z.array(GmailAgentReadGrantSchema).max(200),
  updated_at:z.string().datetime({offset:true}),
}).strict();

export type GmailConnection=z.infer<typeof GmailConnectionSchema>;

/** `GET /api/v1/sources/gmail/connections`: the caller's own connections in the active Space. */
export const GmailConnectionListSchema=z.object({configured:z.boolean(),connections:z.array(GmailConnectionSchema).max(100)}).strict();
export type GmailConnectionList=z.infer<typeof GmailConnectionListSchema>;

/** `POST /api/v1/sources/gmail/oauth/start`. Reconnect names the caller's own connection. */
export const GmailOAuthStartInputSchema=z.object({reconnect_connection_id:id.optional()}).strict();
export const GmailOAuthStartOutputSchema=z.object({authorize_url:z.string().url().max(4096)}).strict();
export type GmailOAuthStartOutput=z.infer<typeof GmailOAuthStartOutputSchema>;

/** The only values the OAuth callback renders into `/sources?gmail=<value>`. */
export const GMAIL_OAUTH_CALLBACK_RESULTS=[
  'connected','gmail_not_configured','gmail_oauth_session_required','gmail_oauth_state_invalid','gmail_oauth_denied',
  'gmail_oauth_exchange_failed','gmail_identity_invalid','gmail_scope_missing','gmail_scope_excess',
  'gmail_refresh_token_missing','gmail_account_mismatch','gmail_profile_unavailable','gmail_connection_unavailable',
  'gmail_oauth_superseded',
] as const;
export const GmailOAuthCallbackResultSchema=z.enum(GMAIL_OAUTH_CALLBACK_RESULTS);
export type GmailOAuthCallbackResult=z.infer<typeof GmailOAuthCallbackResultSchema>;

export const GmailConnectionTargetSchema=z.object({connection_id:id}).strict();
/**
 * Local disconnect receipt: Rainver's credential (refresh and access token) is
 * deleted and no further read is admitted. `remote_revocation` is always
 * `not_requested`: nothing was sent to Google, and the grant stays until the
 * person removes it at `manual_revocation_url`.
 */
export const GmailConnectionDisconnectOutputSchema=z.object({
  connection_id:id,space_id:id,status:z.literal('disconnected'),generation:z.number().int().min(1),
  remote_revocation:z.literal('not_requested'),manual_revocation_url:z.literal(GMAIL_MANUAL_REVOCATION_URL),
}).strict();
export const GmailConnectionForgetOutputSchema=z.object({connection_id:id,space_id:id,forgotten:z.literal(true)}).strict();
/**
 * The owner's standing opt-in for on-demand Agent reads (ADR 0032). It reads
 * nothing by itself: it only lets the owner's own direct conversations offer
 * an Agent `source.gmail.mail.read`, which still needs the owner's consent for
 * that one Run. Those conversations then launch without network apart from the
 * model channel, so it is off by default.
 */
export const GmailConnectionSetAgentReadInputSchema=z.object({connection_id:id,enabled:z.boolean()}).strict();
export const GmailConnectionSetAgentReadOutputSchema=z.object({connection_id:id,space_id:id,agent_read_enabled:z.boolean()}).strict();

const iso=z.string().datetime({offset:true});
/** Gmail thread/message ids: lowercase hex, meaningful only together with their connection. */
export const GmailGoogleIdSchema=z.string().regex(/^[0-9a-f]{1,64}$/);
const gmailUrl=z.string().url().max(2048);
/** Opaque server-signed page cursor bound to owner, connection, generation, Project and query/selection; never a URL. */
const cursor=z.string().min(1).max(4096).regex(/^[A-Za-z0-9_.-]+$/);

/**
 * The owner's reference to one thread for one Project. Owner-only even in a
 * shared Project: other members (owners/admins included) never see it. No
 * subject, snippet, address or body is stored; `project_readable` is false when
 * the owner lost Project access (the row stays removable, never readable).
 */
export const GmailThreadSelectionSchema=z.object({
  id,project_id:id,connection_id:id,google_thread_id:GmailGoogleIdSchema,
  read_after:iso.nullable(),read_before:iso.nullable(),project_readable:z.boolean(),
  gmail_url:gmailUrl,created_at:iso,updated_at:iso,
}).strict();
export type GmailThreadSelection=z.infer<typeof GmailThreadSelectionSchema>;
/** `GET /api/v1/sources/gmail/selections[?project_id=&connection_id=]`: the caller's own rows only. */
export const GmailThreadSelectionListSchema=z.object({selections:z.array(GmailThreadSelectionSchema).max(1000)}).strict();
export type GmailThreadSelectionList=z.infer<typeof GmailThreadSelectionListSchema>;

/**
 * Selections are legacy references from the retired manual search/select flow
 * (Gmail V2): no new selection can be added. Existing rows stay readable and
 * removable by their owner only.
 */
export const GmailSelectionRemoveInputSchema=z.object({selection_id:id}).strict();
export const GmailSelectionRemoveOutputSchema=z.object({selection_id:id,space_id:id,removed:z.literal(true)}).strict();

/** Why a page carries less than a full set: each reason is explicit, never silent. */
export const GmailTruncationReasonSchema=z.enum(['thread_message_limit','page_raw_bytes','page_text_bytes']);
/** A thread or message that is listed without content, with its Gmail link. */
export const GmailOmittedReasonSchema=z.enum(['too_large','unavailable','page_limit']);

/** `POST /api/v1/sources/gmail/selections/:selectionId/read`: newest messages first, 20 per page. */
export const GmailThreadReadInputSchema=z.object({cursor:cursor.optional()}).strict();
export const GmailMessageSchema=z.object({
  google_message_id:GmailGoogleIdSchema,internal_date:iso,subject:z.string().max(1000).nullable(),from:z.string().max(1000).nullable(),
  to:z.string().max(1000).nullable(),cc:z.string().max(1000).nullable(),date_header:z.string().max(256).nullable(),
  /** Plain text only: HTML is converted to text, no markup, images or links are rendered. */
  text:z.string(),text_format:z.enum(['plain','html_converted','none']),text_truncated:z.boolean(),
  attachment_count:z.number().int().min(0),omitted:GmailOmittedReasonSchema.nullable(),gmail_url:gmailUrl,
}).strict();
export type GmailMessage=z.infer<typeof GmailMessageSchema>;
export const GmailThreadReadOutputSchema=z.object({
  selection_id:id,project_id:id,connection_id:id,google_thread_id:GmailGoogleIdSchema,gmail_url:gmailUrl,
  subject:z.string().max(1000).nullable(),messages_in_window:z.number().int().min(0),messages:z.array(GmailMessageSchema).max(20),
  next_cursor:cursor.nullable(),truncated:z.boolean(),truncation:z.array(GmailTruncationReasonSchema).max(3),
}).strict();
export type GmailThreadReadOutput=z.infer<typeof GmailThreadReadOutputSchema>;

/** `GET /api/v1/sources/gmail/read-audit`: the caller's own owner-read audit, newest first; ids and counts only. */
export const GmailReadAuditEventSchema=z.object({
  id,connection_id:id.nullable(),project_id:id.nullable(),selection_id:id.nullable(),operation:z.enum(['thread_search','thread_read','agent_read','digest_read']),
  google_thread_id:GmailGoogleIdSchema.nullable(),item_count:z.number().int().min(0),truncated:z.boolean(),accessed_at:iso,
}).strict();
export const GmailReadAuditListSchema=z.object({events:z.array(GmailReadAuditEventSchema).max(100)}).strict();
export type GmailReadAuditList=z.infer<typeof GmailReadAuditListSchema>;

/**
 * Gmail new-mail monitoring (V2 first version). A monitor is the owner's
 * private rule; the server matches new mail against it deterministically and
 * sends the owner alone a content-free reminder. No Agent reads mail here; an
 * Agent may only draft a monitor as a proposal the owner confirms. A Project
 * is an optional *context* label, never an audience: other Project members
 * see neither the monitor nor its reminders.
 *
 * Criteria are fixed fields, never a free Gmail query: each non-empty field
 * must match (AND); within a field any value matches (OR); at least one field
 * is required. `from_any` is a full address (`a@b.example`) or a domain
 * (`@b.example`); `subject_any` is a case-insensitive phrase; `label_any` is a
 * Gmail label id. Drafts, sent, spam, trash and chat messages never match.
 */
const monitorAddress=z.string().trim().toLowerCase().min(3).max(254).regex(/^(?:[^\s@<>",;]+@|@)[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/);
const monitorPhrase=z.string().trim().min(2).max(100).regex(/^[^\x00-\x1f\x7f]+$/);
const monitorLabel=z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_]+$/);
export const GMAIL_MONITOR_LIMITS=Object.freeze({rulesPerConnection:20,valuesPerField:10,purposeChars:280});
export const GmailMonitorCriteriaSchema=z.object({
  from_any:z.array(monitorAddress).max(10).default([]),
  subject_any:z.array(monitorPhrase).max(10).default([]),
  label_any:z.array(monitorLabel).max(5).default([]),
}).strict().refine((c)=>c.from_any.length+c.subject_any.length+c.label_any.length>0,{message:'At least one criterion is required.'});
export type GmailMonitorCriteria=z.infer<typeof GmailMonitorCriteriaSchema>;
export const GmailMonitorStatusSchema=z.enum(['active','paused']);
export const GmailMonitorSchema=z.object({
  id,connection_id:id,project_id:id.nullable(),purpose:z.string().max(280),criteria:GmailMonitorCriteriaSchema,
  status:GmailMonitorStatusSchema,active_since:iso,match_count:z.number().int().min(0),last_matched_at:iso.nullable(),
  created_at:iso,updated_at:iso,
}).strict();
export type GmailMonitor=z.infer<typeof GmailMonitorSchema>;
/** Content-free sync status of one connection; `push` is whether a current Gmail watch backs the schedule. */
export const GmailMailboxSyncStatusSchema=z.object({
  connection_id:id,state:z.enum(['baseline','ok','recovering']),push:z.enum(['not_configured','active','inactive']),
  last_success_at:iso.nullable(),next_check_at:iso.nullable(),recovery_partial:z.boolean(),
  last_error_code:z.string().regex(/^gmail_[a-z_]{1,58}$/).nullable(),
}).strict();
export type GmailMailboxSyncStatus=z.infer<typeof GmailMailboxSyncStatusSchema>;
/** One recent match: the Gmail message id and its link, never subject, sender or text. */
export const GmailMonitorMatchSchema=z.object({monitor_id:id,google_message_id:GmailGoogleIdSchema,gmail_url:gmailUrl,matched_at:iso}).strict();
/** `GET /api/v1/sources/gmail/monitors`: the caller's own monitors, sync status and recent matches in the active Space. */
export const GmailMonitorListSchema=z.object({
  push_configured:z.boolean(),monitors:z.array(GmailMonitorSchema).max(1000),sync:z.array(GmailMailboxSyncStatusSchema).max(100),
  recent_matches:z.array(GmailMonitorMatchSchema).max(50),
}).strict();
export type GmailMonitorList=z.infer<typeof GmailMonitorListSchema>;
export const GmailMonitorSetStatusInputSchema=z.object({monitor_id:id,status:GmailMonitorStatusSchema}).strict();
export const GmailMonitorSetStatusOutputSchema=z.object({monitor_id:id,space_id:id,status:GmailMonitorStatusSchema}).strict();
export const GmailMonitorDeleteInputSchema=z.object({monitor_id:id}).strict();
export const GmailMonitorDeleteOutputSchema=z.object({monitor_id:id,space_id:id,deleted:z.literal(true)}).strict();
/**
 * `source.gmail.monitor.propose` (Agent tool): drafts a monitor from what the
 * person asked for. Only in the person's own turn with an owner-only
 * audience; the result is a private proposal the owner accepts or declines.
 */
export const GmailMonitorProposeInputSchema=z.object({
  purpose:z.string().trim().min(1).max(280).describe('One sentence, in the person\'s words, of what to watch for and why.'),
  from_any:z.array(monitorAddress).max(10).optional().describe('Sender addresses (a@b.example) or domains (@b.example); any one matches.'),
  subject_any:z.array(monitorPhrase).max(10).optional().describe('Subject phrases, case-insensitive; any one matches.'),
  label_any:z.array(monitorLabel).max(5).optional().describe('Gmail label ids such as INBOX, IMPORTANT, CATEGORY_UPDATES; any one matches.'),
  mailbox_email:z.string().trim().toLowerCase().max(320).optional().describe('Only when the person has several Gmail connections: which mailbox.'),
}).strict();
export type GmailMonitorProposeInput=z.infer<typeof GmailMonitorProposeInputSchema>;
/** The `gmail_monitor_create` proposal payload; only the owner may accept it. */
export const GmailMonitorProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_monitor_create'),action_id:z.literal('source.gmail.monitor.propose'),
  connection_id:id,purpose:z.string().min(1).max(280),criteria:GmailMonitorCriteriaSchema,target_project_id:id.nullable(),
}).passthrough();

/**
 * `source.gmail.mail.read` (Agent tool, ADR 0032, ADR 0033 §6): the owner's
 * most recent inbox messages, or a Gmail search, with plain-text bodies, for
 * the same conversation to answer. Only in the mailbox owner's own turn in an
 * ordinary conversation of a Project whose readers all read it, on that
 * conversation's own runtime, under the owner's standing consent for the
 * Project. The result reaches the runtime only; it is never stored.
 */
const agentQuery=z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const GMAIL_AGENT_READ_LIMITS=Object.freeze({
  messagesPerCall:5,
  /** Plain text per message handed to the model; the rest is marked truncated. */
  textBytesPerMessage:32*1024,
  /** Successful reads one Run may make under the owner's Project consent; the next turn starts a new Run. */
  readsPerRun:10,
});
export const GmailAgentReadInputSchema=z.object({
  query:agentQuery.optional().describe('Gmail search words, for example superlinear or from:alice@example.com. Omit to read the most recent inbox messages.'),
  max_messages:z.number().int().min(1).max(GMAIL_AGENT_READ_LIMITS.messagesPerCall).optional().describe('How many messages, newest first (1-5, default 5).'),
  mailbox_email:z.string().trim().toLowerCase().max(320).optional().describe('Only when the person has several Gmail connections: which mailbox.'),
}).strict();
export type GmailAgentReadInput=z.infer<typeof GmailAgentReadInputSchema>;
export const GmailAgentMessageSchema=z.object({
  id:GmailGoogleIdSchema,internal_date:iso,subject:z.string().max(1000).nullable(),from:z.string().max(1000).nullable(),
  to:z.string().max(1000).nullable(),cc:z.string().max(1000).nullable(),date_header:z.string().max(256).nullable(),
  text:z.string(),text_format:z.enum(['plain','html_converted','none']),text_truncated:z.boolean(),
  attachment_count:z.number().int().min(0),
}).strict();
export type GmailAgentMessage=z.infer<typeof GmailAgentMessageSchema>;
/**
 * `truncated` is true when a message's text was cut at the per-message limit,
 * or a listed message could not be read (too large, gone, or over the read's
 * byte budget) and is missing from `items`. Drafts, chats, spam and trash are
 * never included.
 */
export const GmailAgentReadOutputSchema=z.object({
  mailbox_email:z.string().max(320),source:z.enum(['recent_inbox','search']),
  items:z.array(GmailAgentMessageSchema).max(GMAIL_AGENT_READ_LIMITS.messagesPerCall),truncated:z.boolean(),
}).strict();
export type GmailAgentReadOutput=z.infer<typeof GmailAgentReadOutputSchema>;

/**
 * Gmail digests (ADR 0033 phase B): the owner's scheduled private summaries.
 *
 * - `daily`: every day at `local_time` in `time_zone`, the owner's Agent
 *   summarizes the inbox mail of the window since the last delivered one (at
 *   most 24 h; no search words, server-built window only). An earlier gap is
 *   reported, never silently skipped.
 * - `rule`: as matches arrive, the Agent summarizes the messages the
 *   owner's monitors matched since the last delivery (server-matched ids only,
 *   each delivered once). No match means no Run.
 *
 * One confirmation card in the owner's turn of a Project conversation (their
 * private one, a Room or the mainline) creates it; the summary is delivered
 * only into that conversation. The owner pauses,
 * resumes or ends it on the Gmail card. Nothing here carries mail content.
 */
export const GMAIL_DIGEST_LIMITS=Object.freeze({
  /** Messages one read call returns. */
  messagesPerCall:10,
  /** Read calls one digest Run may make (the daily window pages through them). */
  readsPerRun:5,
  /** Plain text per message handed to the model. */
  textBytesPerMessage:8*1024,
  /** Longest daily window: the time since the last delivery, capped. */
  windowHours:24,
  /** Run time of one digest Run. */
  runSeconds:600,
});
export const GmailDigestKindSchema=z.enum(['daily','rule']);
export type GmailDigestKind=z.infer<typeof GmailDigestKindSchema>;
export const GmailDigestPurposeSchema=z.enum(['daily_digest','rule_digest']);
export const gmailDigestPurpose=(kind:GmailDigestKind)=>kind==='daily'?'daily_digest' as const:'rule_digest' as const;
const localTime=z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/);
const timeZone=z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);
/** `source.gmail.digest.propose` (Agent tool): only in the mailbox owner's own turn of a Project conversation whose readers all read the Project. */
const digestMailbox = z.string().trim().toLowerCase().max(320).optional().describe('Only when the person has several Gmail connections: which mailbox.');
export const GmailDigestProposeInputSchema=z.discriminatedUnion('kind', [
  z.object({
    kind:z.literal('daily'),
    local_time:localTime.describe('Delivery time, 24-hour HH:MM, in time_zone.'),
    time_zone:timeZone.describe('IANA time zone of the owner.'),
    mailbox_email:digestMailbox,
  }).strict(),
  z.object({kind:z.literal('rule'), mailbox_email:digestMailbox}).strict(),
]);
export type GmailDigestProposeInput=z.infer<typeof GmailDigestProposeInputSchema>;
/** The `gmail_digest_create` payload: everything the one confirmation card shows and the acceptance writes. */
export const GmailDigestProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_digest_create'),action_id:z.literal('source.gmail.digest.propose'),
  kind:GmailDigestKindSchema,connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),
  project_id:id,session_id:id,agent_id:id,local_time:localTime.nullable(),time_zone:timeZone.nullable(),
  /** The delivery conversation is a Room or the Project mainline (every member reads the digest); absent on earlier cards. */
  shared_conversation:z.boolean().optional(),
}).passthrough();
export type GmailDigestProposalPayload=z.infer<typeof GmailDigestProposalPayloadSchema>;
/** Longest request text a `gmail_private_read` card carried. */
export const GMAIL_PRIVATE_READ_REQUEST_MAX_CHARS=8000;
/**
 * The `gmail_private_read` payload of a withdrawn hand-off card (ADR 0033 §6): kept to read the owner-only
 * history of such cards. Nothing creates one now and none is ever executed.
 */
export const GmailPrivateReadProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_private_read'),action_id:z.literal('source.gmail.private_read.request'),
  connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),
  project_id:id,project_name:z.string().max(512),agent_id:id,source_run_id:id,source_message_id:id,
  request_text:z.string().min(1).max(GMAIL_PRIVATE_READ_REQUEST_MAX_CHARS),consent:z.enum(['existing','confirm']),
}).passthrough();
export type GmailPrivateReadProposalPayload=z.infer<typeof GmailPrivateReadProposalPayloadSchema>;
/**
 * The `gmail_private_check` payload of a withdrawn in-place check card (ADR 0033 §6): kept
 * to read the owner-only history cards; nothing creates or executes one any more.
 */
export const GmailPrivateCheckProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_private_check'),action_id:z.literal('source.gmail.private_check.request'),
  check_id:id,connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),
  project_id:id,project_name:z.string().max(512),agent_id:id,source_run_id:id,source_session_id:id,source_message_id:id,
  consent:z.enum(['existing','confirm']),
}).passthrough();
export type GmailPrivateCheckProposalPayload=z.infer<typeof GmailPrivateCheckProposalPayloadSchema>;
export const GmailDigestStatusSchema=z.enum(['active','paused','ended']);
export const GmailDigestDeliveryStatusSchema=z.enum(['running','delivered','failed']);
const gmailCode=z.string().regex(/^gmail_[a-z_]{1,58}$/);
export const GmailDigestSchema=z.object({
  id,connection_id:id,project_id:id,project_name:z.string().max(512).nullable(),session_id:id,agent_id:id,kind:GmailDigestKindSchema,
  /** The Room (or Project mainline) the digest delivers into; null for the owner's private conversation. */
  room_id:id.nullable().optional(),
  local_time:localTime.nullable(),time_zone:timeZone.nullable(),status:GmailDigestStatusSchema,
  /** Start of the mail the next daily window covers, or since when rule matches count. */
  covered_until:iso,next_run_at:iso.nullable(),retry_at:iso.nullable(),
  last_delivered_at:iso.nullable(),failure_count:z.number().int().min(0),last_error_code:gmailCode.nullable(),
  last_delivery:z.object({status:GmailDigestDeliveryStatusSchema,window_start:iso,window_end:iso,message_count:z.number().int().min(0),
    gap_before:z.boolean(),error_code:gmailCode.nullable(),finished_at:iso.nullable()}).strict().nullable(),
  created_at:iso,
}).strict();
export type GmailDigest=z.infer<typeof GmailDigestSchema>;
/** `GET /api/v1/sources/gmail/digests`: the caller's own digests in the active Space. */
export const GmailDigestListSchema=z.object({digests:z.array(GmailDigestSchema).max(200)}).strict();
export type GmailDigestList=z.infer<typeof GmailDigestListSchema>;
export const GmailDigestSetStatusInputSchema=z.object({digest_id:id,status:z.enum(['active','paused'])}).strict();
export const GmailDigestSetStatusOutputSchema=z.object({digest_id:id,space_id:id,status:z.enum(['active','paused'])}).strict();
export const GmailDigestSetTimeInputSchema=z.object({digest_id:id,local_time:localTime}).strict();
/** Ending revokes the digest's consent; the history stays and it never runs again. */
export const GmailDigestEndInputSchema=z.object({digest_id:id}).strict();
export const GmailDigestEndOutputSchema=z.object({digest_id:id,space_id:id,status:z.literal('ended')}).strict();
/**
 * `source.gmail.digest.read` (Agent tool of a digest Run only): the mail of the
 * window the server froze for this delivery. `page_token` continues a daily
 * window from the previous call. `more_in_window` is true when the window holds
 * more mail than this call returned; `gap_before` that mail before the window
 * was not covered (the last delivery was more than a day ago).
 */
export const GmailDigestReadInputSchema=z.object({
  page_token:z.string().max(1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).optional().describe('next_page_token from the previous call, to continue the same window.'),
}).strict();
export type GmailDigestReadInput=z.infer<typeof GmailDigestReadInputSchema>;
export const GmailDigestReadOutputSchema=z.object({
  mailbox_email:z.string().max(320),kind:GmailDigestKindSchema,window_start:iso,window_end:iso,gap_before:z.boolean(),
  items:z.array(GmailAgentMessageSchema).max(GMAIL_DIGEST_LIMITS.messagesPerCall),
  next_page_token:z.string().max(1024).nullable(),more_in_window:z.boolean(),truncated:z.boolean(),
}).strict();
export type GmailDigestReadOutput=z.infer<typeof GmailDigestReadOutputSchema>;

/** The owner posts their edited preview as their own message in a Project Room. */
export const GmailSharePreviewInputSchema=z.object({source_message_id:id,room_id:id,session_id:id}).strict();
const gmailShareAudienceVersion=z.string().regex(/^[a-f0-9]{64}$/);
export const GmailSharePreviewOutputSchema=z.object({
  audience_version:gmailShareAudienceVersion,
  readers:z.array(z.object({display_name:z.string()}).strict()),
}).strict();
export const GmailShareInputSchema=GmailSharePreviewInputSchema.extend({
  content:z.string().trim().min(1).max(8000),audience_version:gmailShareAudienceVersion,
}).strict();
export const GmailShareOutputSchema=z.object({message_id:id,source_message_id:id,room_id:id,session_id:id}).strict();

export const GMAIL_OPERATION_SCHEMAS={
  'source.gmail.summary.preview':{input:GmailSharePreviewInputSchema,output:GmailSharePreviewOutputSchema},
  'source.gmail.summary.share':{input:GmailShareInputSchema,output:GmailShareOutputSchema},
  'source.gmail.digest.read':{input:GmailDigestReadInputSchema,output:GmailDigestReadOutputSchema},
  'source.gmail.digest.set_status':{input:GmailDigestSetStatusInputSchema,output:GmailDigestSetStatusOutputSchema},
  'source.gmail.digest.set_time':{input:GmailDigestSetTimeInputSchema,output:GmailDigestSetStatusOutputSchema},
  'source.gmail.digest.end':{input:GmailDigestEndInputSchema,output:GmailDigestEndOutputSchema},
  'source.gmail.connection.set_agent_read':{input:GmailConnectionSetAgentReadInputSchema,output:GmailConnectionSetAgentReadOutputSchema},
  'source.gmail.mail.read':{input:GmailAgentReadInputSchema,output:GmailAgentReadOutputSchema},
  'source.gmail.connection.disconnect':{input:GmailConnectionTargetSchema,output:GmailConnectionDisconnectOutputSchema},
  'source.gmail.connection.forget':{input:GmailConnectionTargetSchema,output:GmailConnectionForgetOutputSchema},
  'source.gmail.selection.remove':{input:GmailSelectionRemoveInputSchema,output:GmailSelectionRemoveOutputSchema},
  'source.gmail.monitor.set_status':{input:GmailMonitorSetStatusInputSchema,output:GmailMonitorSetStatusOutputSchema},
  'source.gmail.monitor.delete':{input:GmailMonitorDeleteInputSchema,output:GmailMonitorDeleteOutputSchema},
} as const;
