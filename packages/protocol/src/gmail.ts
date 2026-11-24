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
  /** Members the owner lets read this mailbox in a Project within a search scope (ADR 0035 §4); active ones, content-free. Absent before it existed. */
  read_delegations:z.array(z.object({
    delegation_id:id,project_id:id,project_name:z.string().max(512).nullable(),grantee_name:z.string().max(200),query_scope:z.string().max(200),
    read_count:z.number().int().min(0),last_used_at:z.string().datetime({offset:true}).nullable(),created_at:z.string().datetime({offset:true}),
  }).strict()).max(200).optional(),
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
/** Google Gmail messages.list page size. */
export const GMAIL_AGENT_PAGE_SIZE = { default: 5, maximum: 500 } as const;
const gmailAgentPageToken = z.string().min(1).regex(/^[^\x00-\x20\x7f]+$/);
export const GmailAgentReadInputSchema=z.object({
  query:agentQuery.optional().describe('Gmail search words, for example superlinear or from:alice@example.com. Omit to read the most recent inbox messages.'),
  max_messages:z.number().int().min(1).max(GMAIL_AGENT_PAGE_SIZE.maximum).optional().describe('Gmail page size, newest first (defaults to 5). Follow next_page_token for more results.'),
  page_token:gmailAgentPageToken.optional().describe('Use next_page_token unchanged with the same mailbox, query and page size.'),
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
 * `truncated` is true when Gmail did not provide all the message text,
 * or a listed message could not be read (too large or gone) and is missing from `items`. Drafts, chats, spam and trash are
 * never included.
 */
export const GmailAgentReadOutputSchema=z.object({
  mailbox_email:z.string().max(320),source:z.enum(['recent_inbox','search']),
  items:z.array(GmailAgentMessageSchema),next_page_token:gmailAgentPageToken.nullable(),truncated:z.boolean(),
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
/**
 * `application` (ADR 0034) is the owner's application-update automation: every new inbox
 * message (no search words or monitor criteria) is read by the Agent and model the owner
 * confirmed on its card, which submits structured external facts the server checks before it
 * records them in this Project's Applications. Its conversation's only reader is the owner.
 */
export const GmailDigestKindSchema=z.enum(['daily','rule','application']);
export type GmailDigestKind=z.infer<typeof GmailDigestKindSchema>;
export const GmailDigestPurposeSchema=z.enum(['daily_digest','rule_digest','application_update']);
export const gmailDigestPurpose=(kind:GmailDigestKind)=>kind==='daily'?'daily_digest' as const:kind==='rule'?'rule_digest' as const:'application_update' as const;
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

/**
 * External facts an application-update automation may record (ADR 0034). Each is a fact the
 * institution states, never the person's decision: accepting or declining an offer, withdrawing,
 * archiving, deleting, unlinking and anything sent stay with the person.
 * - `under_review`, `interview`, `waitlisted`, `offer`, `rejected`: the application's external result,
 *   only forward (an older message never moves a newer status back);
 * - `submission_received`: the institution confirms it received the submitted application;
 * - `deadline`: a deadline the message announces or moves, on the application's deadline of that kind.
 */
export const GMAIL_APPLICATION_UPDATE_EFFECTS=['under_review','interview','waitlisted','offer','rejected','submission_received','deadline','contact'] as const;
export const GmailApplicationUpdateEffectSchema=z.enum(GMAIL_APPLICATION_UPDATE_EFFECTS);
export type GmailApplicationUpdateEffect=z.infer<typeof GmailApplicationUpdateEffectSchema>;
/** The action an automation Run records one fact with; only that Run may call it (ADR 0034). */
export const GMAIL_APPLICATION_FACT_ACTION='plugin.applications.mail_fact.apply' as const;
/**
 * The owner's ledger of what their mail recorded (ADR 0034): answered only to the owner, or to an Agent in
 * their own private conversation of the Project, where it taints the Run as the owner's mail does.
 */
export const GMAIL_APPLICATION_FACTS_LIST_ACTION='plugin.applications.mail_fact.list' as const;
/**
 * The Agent and model the owner confirmed for an automation, frozen from the conversation's
 * binding when the card was drafted. A delivery starts only while the conversation still binds
 * exactly this runtime, model and session configuration for that Agent; otherwise it waits
 * (`gmail_digest_runtime_changed`) until the owner confirms a new card.
 */
export const GmailDigestRuntimeBindingSchema=z.object({
  runtime_profile_id:id,runtime_key:z.string().min(1).max(64),backend_mode:z.enum(['runtime_native','model_provider']),
  model_provider_id:id.nullable(),model_name:z.string().max(255).nullable(),
  session_config:z.array(z.object({id:z.string().min(1).max(256),type:z.enum(['select','boolean']),value:z.union([z.string().max(1000),z.boolean()]),category:z.string().max(128).nullable()}).strict()).max(50),
  agent_name:z.string().max(200),model_label:z.string().max(300),
  /**
   * The model shown and confirmed. A daily or rule digest's: the bound ModelProvider's model, or the conversation's
   * explicit model option (absent for its runtime's default). An application automation's: the model chosen on its card
   * as the conversation's picker names it — an id, an alias or `default` — or a ModelProvider's lease model (ADR 0037).
   * Absent on application cards drafted before it existed: such a card is not accepted and such an automation reads no
   * mail until the owner confirms a new card (ADR 0034).
   */
  pinned_model:z.string().min(1).max(255).optional(),
  /**
   * An application automation's configuration confirmed to launch as the owner's conversation launches its turns
   * (ADR 0037). A configuration confirmed without it was shown under an earlier commitment — a ModelProvider isolated to
   * its lease (ADR 0036 §9), or a runtime-native one gated on proof of the answering model (ADR 0034 §3) — and waits for
   * a new card (`gmail_digest_launch_reconfirm_required`).
   */
  conversation_launch:z.literal(true).optional(),
  sent_from:iso.optional(),
}).strict();
export type GmailDigestRuntimeBinding=z.infer<typeof GmailDigestRuntimeBindingSchema>;
/**
 * `source.gmail.application_updates.propose` (Agent tool): drafts, changes or resumes the owner's
 * application-update automation for this Project. Only in the mailbox owner's own turn of a
 * conversation of the Project whose only reader is the owner; the owner confirms the one card.
 */
export const GmailApplicationUpdatesProposeInputSchema=z.object({
  effects:z.array(GmailApplicationUpdateEffectSchema).min(1).max(GMAIL_APPLICATION_UPDATE_EFFECTS.length).optional()
    .describe('Which external facts may be recorded automatically; omit for all of them. Decisions of the person are never included.'),
  mailbox_email:digestMailbox,
}).strict();
export type GmailApplicationUpdatesProposeInput=z.infer<typeof GmailApplicationUpdatesProposeInputSchema>;
/**
 * The readers of a shared conversation a Gmail card delivers into (ADR 0035): its current readers and the kind
 * of conversation. Everyone who later joins a Room, or the Project for its mainline, reads its history too; the
 * card says so. Acceptance refuses (409) when a reader was added since the card was drafted.
 */
export const GmailCardAudienceSchema=z.object({
  kind:z.enum(['room','mainline']),room_title:z.string().max(512).nullable(),
  reader_user_ids:z.array(id).min(1).max(1000),reader_names:z.array(z.string().max(200)).max(50),
}).strict();
export type GmailCardAudience=z.infer<typeof GmailCardAudienceSchema>;
/** The `gmail_digest_create` payload: everything the one confirmation card shows and the acceptance writes. */
export const GmailDigestProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_digest_create'),action_id:z.enum(['source.gmail.digest.propose','source.gmail.application_updates.propose']),
  kind:GmailDigestKindSchema,connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),
  project_id:id,session_id:id,agent_id:id,local_time:localTime.nullable(),time_zone:timeZone.nullable(),
  /** The delivery conversation is a Room or the Project mainline (every member reads the digest); absent on earlier cards. */
  shared_conversation:z.boolean().optional(),
  /** Application updates only: include newly sent messages in the private report. */
  include_sent:z.literal(true).optional(),
  /** Application updates only: the facts it may record. */
  effects:z.array(GmailApplicationUpdateEffectSchema).min(1).nullable().optional(),
  /** The Agent and model it runs on: application updates (ADR 0034) and every digest card since ADR 0035 §3. */
  runtime_binding:GmailDigestRuntimeBindingSchema.nullable().optional(),
  /**
   * Who reads what the card's delivery conversation receives, as shown when it was drafted (ADR 0035 §1): its
   * current readers by name (and ids, rechecked at acceptance), and whether it is a Room or the mainline — whose
   * history every later member also reads. Absent for the owner's private conversation and on earlier cards.
   */
  audience:GmailCardAudienceSchema.nullable().optional(),
  /**
   * A daily or rule part of a combined card (ADR 0035 §2) that changes the live digest of its kind for this
   * mailbox and Project in place — its time, time zone, conversation or execution configuration differs from what
   * the owner asked for here — keeping its history. Acceptance refuses it once that digest ended or was replaced.
   * An application-update card always carries it (ADR 0036): the automation it changes, or null for a new one; it is
   * accepted only while exactly that automation (or still none) is live, so it never overwrites a newer rule or
   * revives one the owner ended. Absent only on cards drafted before.
   */
  replaces_digest_id:id.nullable().optional(),
  /**
   * The version of that digest the card was drafted against, frozen with it: the accepted card in force then
   * (`proposal_id`) and its daily time (changed without a card by `.set_time`). Acceptance locks the digest and
   * refuses (409 `gmail_digest_changed`) when either differs — another card changed it first, so this one, drafted
   * against what it was before, never overwrites the newer setting.
   */
  replaces_proposal_id:id.nullable().optional(),
  replaces_local_time:localTime.nullable().optional(),
  /** A part of a combined card (`gmail_setup`): the line the card shows for it, so the card can be redrawn when its execution is chosen (ADR 0036). */
  card_summary:z.string().max(4000).optional(),
}).passthrough();
export type GmailDigestProposalPayload=z.infer<typeof GmailDigestProposalPayloadSchema>;
/**
 * An application-update card carries its effects and runtime binding and comes from its own tool; no other card
 * carries effects. A shared conversation's card names its audience and a private one's never does.
 */
export function gmailDigestPayloadConsistent(value:GmailDigestProposalPayload):boolean{
  const application=value.kind==='application';
  // An application card may be drafted before any Agent and model can run it (ADR 0036): its binding is then null
  // until the owner chooses one on the card, and acceptance refuses it while none is chosen.
  return application===(value.action_id==='source.gmail.application_updates.propose')&&application===!!value.effects?.length
    &&(value.shared_conversation===true)===!!value.audience
    &&!!value.replaces_digest_id===!!value.replaces_proposal_id
    &&((!!value.replaces_digest_id&&!application)||value.replaces_local_time==null);
}
/**
 * `source.gmail.setup.propose` (Agent tool, ADR 0035 §2): one card for what the owner asked for in this
 * conversation — on-demand reading, a daily or rule digest and automatic application updates — each written as
 * its own consent and automation, so each pauses and ends on its own. What is already allowed here is reused,
 * never asked again; only something new or wider is on the card.
 */
export const GmailSetupProposeInputSchema=z.object({
  read:z.literal(true).optional().describe('Let Agents read and search this mailbox on request in every conversation of this Project.'),
  daily_digest:z.object({local_time:localTime.describe('Delivery time, 24-hour HH:MM, in time_zone.'),time_zone:timeZone.describe('IANA time zone of the owner.')}).strict().optional()
    .describe('A daily summary of the inbox, delivered into this conversation.'),
  rule_digest:z.literal(true).optional().describe('A summary whenever the owner\'s Gmail monitors match new mail, delivered into this conversation.'),
  application_updates:z.object({effects:z.array(GmailApplicationUpdateEffectSchema).min(1).max(GMAIL_APPLICATION_UPDATE_EFFECTS.length).optional()}).strict().optional()
    .describe('Automatic application updates from new inbox mail; effects narrows the facts it may record.'),
  mailbox_email:digestMailbox,
}).strict().refine((value)=>!!(value.read||value.daily_digest||value.rule_digest||value.application_updates),{message:'Name at least one of read, daily_digest, rule_digest or application_updates.'});
export type GmailSetupProposeInput=z.infer<typeof GmailSetupProposeInputSchema>;
export const GMAIL_SETUP_PURPOSES=['read','daily_digest','rule_digest','application_updates'] as const;
/** The `gmail_setup` payload: the parts the one card shows, each a full digest card payload, plus on-demand reading. */
export const GmailSetupProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_setup'),action_id:z.literal('source.gmail.setup.propose'),
  connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),project_id:id,session_id:id,agent_id:id,
  shared_conversation:z.boolean(),audience:GmailCardAudienceSchema.nullable(),
  /** On-demand reading is new on this card (a live consent for this Project and mailbox is reused instead). */
  on_demand_read:z.boolean(),
  parts:z.array(GmailDigestProposalPayloadSchema).max(3),
  /** Purposes the owner asked for that were already allowed here and are reused unchanged. */
  reused:z.array(z.enum(GMAIL_SETUP_PURPOSES)).max(4),
}).strict();
export type GmailSetupProposalPayload=z.infer<typeof GmailSetupProposalPayloadSchema>;

/**
 * Standing read-only delegated access (ADR 0035 §4): the mailbox owner lets one member of one Project read and
 * search one mailbox within a fixed Gmail search scope, from that member's own turns in that Project's
 * conversations, until revoked. Google stays read-only; nothing is sent, labelled, archived or deleted.
 */
export const GMAIL_DELEGATION_SCOPE_MAX_CHARS=100;
const delegationScope=z.string().trim().min(1).max(GMAIL_DELEGATION_SCOPE_MAX_CHARS)
  .refine((value)=>!/[\u0000-\u001f\u007f]/.test(value),'No control characters.');
export const GmailDelegationProposeInputSchema=z.object({
  member:z.string().trim().min(1).max(320).describe('The Project member to let read: their name or email address as the owner said it.'),
  query_scope:delegationScope.describe('Gmail search words every read of that member is confined to, for example label:applications or from:@uni.example. Ask the owner; never widen it.'),
  mailbox_email:digestMailbox,
}).strict();
export type GmailDelegationProposeInput=z.infer<typeof GmailDelegationProposeInputSchema>;
export const GmailDelegationProposalPayloadSchema=z.object({
  proposal_type:z.literal('gmail_read_delegation'),action_id:z.literal('source.gmail.delegation.propose'),
  connection_id:id,connection_generation:z.number().int().min(1),mailbox_email:z.string().max(320),project_id:id,session_id:id,
  grantee_user_id:id,grantee_name:z.string().max(200),query_scope:delegationScope,
}).strict();
export type GmailDelegationProposalPayload=z.infer<typeof GmailDelegationProposalPayloadSchema>;
export const GmailDelegationSchema=z.object({
  delegation_id:id,status:z.enum(['active','revoked']),project_id:id,grantee_user_id:id,grantee_name:z.string().max(200),
  mailbox_email:z.string().max(320).optional(),query_scope:z.string().max(GMAIL_DELEGATION_SCOPE_MAX_CHARS),
  read_count:z.number().int().min(0),last_used_at:iso.nullable(),created_at:iso,end_reason:z.string().max(64).nullable(),
}).strict();
export const GmailDelegationListInputSchema=z.object({}).strict();
export const GmailDelegationListOutputSchema=z.object({delegations:z.array(GmailDelegationSchema).max(100)}).strict();
export const GmailDelegationRevokeInputSchema=z.object({delegation_id:id}).strict();
export const GmailDelegationRevokeOutputSchema=z.object({delegation_id:id,status:z.literal('revoked')}).strict();
/** `source.gmail.delegated.read` (Agent tool): a member's read of the owner's mail under the owner's delegation. */
export const GmailDelegatedReadInputSchema=GmailAgentReadInputSchema.extend({
  mailbox_email:z.string().trim().toLowerCase().max(320).optional().describe('Only when several mailboxes were delegated to you in this Project: which mailbox.'),
}).strict();
export type GmailDelegatedReadInput=z.infer<typeof GmailDelegatedReadInputSchema>;

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
  /** Application updates: the facts it records and the Agent and model it runs on (absent for summaries). */
  effects:z.array(GmailApplicationUpdateEffectSchema).nullable().optional(),
  runtime:z.object({agent_name:z.string().max(200),model_label:z.string().max(300)}).strict().nullable().optional(),
  /** Application updates: messages waiting, kept for the owner's review, and given up after repeated failures. */
  mail_items:z.object({pending:z.number().int().min(0),review:z.number().int().min(0),failed:z.number().int().min(0)}).strict().nullable().optional(),
  /** The Room (or Project mainline) the digest delivers into; null for the owner's private conversation. */
  room_id:id.nullable().optional(),
  /** Application updates enabled in a Room or the mainline (ADR 0035 §1): that conversation, where structured results are posted. */
  notice_room_id:id.nullable().optional(),
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
  items:z.array(GmailAgentMessageSchema.extend({direction:z.literal('sent').optional()})).max(GMAIL_DIGEST_LIMITS.messagesPerCall),
  next_page_token:z.string().max(1024).nullable(),more_in_window:z.boolean(),truncated:z.boolean(),
}).strict();
export type GmailDigestReadOutput=z.infer<typeof GmailDigestReadOutputSchema>;

/**
 * Agent tools of the application-update automation (ADR 0034), all content-free: message ids,
 * Gmail links, application ids and fixed codes, never subject, sender or text.
 *
 * - `source.gmail.application_updates.list`: the owner's automations for this Project and the
 *   recent per-message outcome, in the owner's own turn of a conversation only they read.
 * - `source.gmail.application_updates.set_status`: pause or end one (narrowing only; changing
 *   or resuming it is a new card from `.propose`).
 * - `source.gmail.application_updates.flag`: inside an automation Run, keep one read message for
 *   the owner's review (no unique application, unclear fact) instead of recording anything.
 */
export const GmailApplicationMailItemStatusSchema=z.enum(['pending','done','review','failed']);
const gmailItemReason=z.enum(['ambiguous_application','no_matching_application','unclear_fact','conflict']);
export const GmailApplicationUpdatesListInputSchema=z.object({}).strict();
export const GmailApplicationUpdatesListOutputSchema=z.object({
  automations:z.array(z.object({
    digest_id:id,status:GmailDigestStatusSchema,mailbox_email:z.string().max(320).optional(),effects:z.array(GmailApplicationUpdateEffectSchema),
    agent_name:z.string().max(200),model_label:z.string().max(300),covered_until:iso,last_delivered_at:iso.nullable(),
    last_error_code:gmailCode.nullable(),failure_count:z.number().int().min(0),
    /** Where its structured results are posted: only the owner's private conversation, or also a shared one (ADR 0035 §1). */
    results_to:z.enum(['private','shared']),
    /** Per-message outcomes are the owner's mail: answered only in a conversation only the owner reads. */
    mail_items:z.object({pending:z.number().int().min(0),review:z.number().int().min(0),failed:z.number().int().min(0)}).strict().optional(),
    recent:z.array(z.object({
      message_id:GmailGoogleIdSchema,gmail_url:z.string().url().max(300),received_at:iso,status:GmailApplicationMailItemStatusSchema,
      reason:gmailItemReason.nullable(),candidate_application_ids:z.array(id).max(5),
    }).strict()).max(20).optional(),
  }).strict()).max(10),
}).strict();
export type GmailApplicationUpdatesListOutput=z.infer<typeof GmailApplicationUpdatesListOutputSchema>;
export const GmailApplicationUpdatesSetStatusInputSchema=z.object({digest_id:id,status:z.enum(['paused','ended'])}).strict();
export const GmailApplicationUpdatesFlagInputSchema=z.object({
  message_id:GmailGoogleIdSchema,reason:gmailItemReason,
  candidate_application_ids:z.array(id).max(5).optional().describe('Applications the message might concern, when it could be more than one.'),
}).strict();
export type GmailApplicationUpdatesFlagInput=z.infer<typeof GmailApplicationUpdatesFlagInputSchema>;

/**
 * The Agent and model an application-update automation runs on, chosen by the mailbox owner on its card (ADR 0036), in
 * two levels: a configuration — an Agent the owner may use in the Project (its list and its own Assistant) with one
 * runtime profile the owner can run in their own private conversation — and then one of the models that conversation's
 * picker offers for it (ADR 0037). A configuration that cannot run it at all says why once and is not selectable.
 */
export const GMAIL_APPLICATION_EXECUTION_REASONS=[
  'agent_unavailable','no_runtime','host_not_owner','host_offline','runtime_unavailable','model_unresolved',
  // A ModelProvider configuration, checked as its lease and Profile admission check it (ADR 0036 §9): the runtime cannot be
  // bound to a ModelProvider, the Provider cannot be used now, speaks no protocol the runtime does, or lacks that protocol's
  // compatible URL.
  'provider_unsupported','provider_unavailable','provider_protocol_unsupported','provider_endpoint_missing',
] as const;
export const GmailApplicationExecutionReasonSchema=z.enum(GMAIL_APPLICATION_EXECUTION_REASONS);
/**
 * At most this many models of one configuration are listed at a time; the rest are counted (`omitted_models`) and listed
 * by `models_cursor` (`execution_options` `models_of`). The saved model is always listed with its configuration, one more.
 */
export const GMAIL_APPLICATION_EXECUTION_MODELS_PER_CONFIGURATION=200;
/**
 * Where the next models of one configuration start: the model listed last before them and its place, so a model removed
 * from the runtime's list meanwhile skips nothing after it; when that model itself is gone the list starts over
 * (`models_restarted`). Opaque to clients.
 */
const applicationExecutionModelsCursor=z.string().regex(/^\d{1,6}\.[A-Za-z0-9_-]{1,400}$/);
/** One model of an available configuration, as the conversation's picker offers it: its value and the picker's name for it. */
export const GmailApplicationExecutionModelSchema=z.object({
  model:z.string().max(255),name:z.string().max(200).nullable(),
}).strict();
export const GmailApplicationExecutionConfigurationSchema=z.object({
  agent_id:id,agent_name:z.string().max(200),agent_kind:z.enum(['standard','system_assistant']),
  /** Null when the Agent itself cannot run it (`agent_unavailable`, `no_runtime`): then it has no profile to name. */
  runtime_profile_id:id.nullable(),profile_name:z.string().max(200).nullable(),runtime_key:z.string().max(64).nullable(),
  backend_mode:z.enum(['runtime_native','model_provider']).nullable(),
  /** True when it can run it (then every model listed can be chosen); `reason` is then null. */
  available:z.boolean(),reason:GmailApplicationExecutionReasonSchema.nullable(),
  /** Its models (none for an unavailable configuration). */
  models:z.array(GmailApplicationExecutionModelSchema).max(GMAIL_APPLICATION_EXECUTION_MODELS_PER_CONFIGURATION+1),
  /** How many of its models come after these; `models_cursor` lists them (null when none). */
  omitted_models:z.number().int().nonnegative(),
  models_cursor:applicationExecutionModelsCursor.nullable(),
}).strict();
export type GmailApplicationExecutionConfiguration=z.infer<typeof GmailApplicationExecutionConfigurationSchema>;
export type GmailApplicationExecutionReason=z.infer<typeof GmailApplicationExecutionReasonSchema>;
export type GmailApplicationExecutionModel=z.infer<typeof GmailApplicationExecutionModelSchema>;
export const GmailApplicationExecutionSelectionSchema=z.object({agent_id:id,runtime_profile_id:id,model:z.string().trim().min(1).max(255)}).strict();
export type GmailApplicationExecutionSelection=z.infer<typeof GmailApplicationExecutionSelectionSchema>;
/**
 * Where a page of the card's configurations starts: the Agent it starts at, named by its place in the card's fixed order
 * (phase — the Project's Assistant or its Agents — and the UTC microsecond it was added, then its id) and its configuration
 * there. Keyed, never an offset: an Agent removed before it skips nothing after it. Opaque to clients.
 */
const applicationExecutionCursor=z.string().regex(/^[01]\.\d{20}\.[A-Za-z0-9_-]{1,96}\.\d{1,6}$/);
/**
 * `cursor`: the `next_cursor` of the page shown before (the first page when omitted). `models_of`: instead of a page of
 * configurations, that one configuration alone (checked by itself) with its models from its `models_cursor`, and `next_cursor`
 * null; `cursor` is then not read.
 */
export const GmailApplicationExecutionOptionsInputSchema=z.object({
  proposal_id:id,cursor:applicationExecutionCursor.optional(),
  models_of:z.object({agent_id:id,runtime_profile_id:id,models_cursor:applicationExecutionModelsCursor}).strict().optional(),
}).strict();
/** What the owner decides on: the scope (mailbox, what is read, what may change, who reads the results) and the execution choice. */
export const GmailApplicationExecutionOptionsOutputSchema=z.object({
  proposal_id:id,
  /** False for a combined card without an application-update part: nothing to choose. */
  applies:z.boolean(),
  scope:z.object({
    include_sent:z.literal(true).optional(),
    mailbox_email:z.string().max(320),effects:z.array(GmailApplicationUpdateEffectSchema).max(GMAIL_APPLICATION_UPDATE_EFFECTS.length),
    results_to:z.enum(['private','room','mainline']),room_title:z.string().max(512).nullable(),
    reader_names:z.array(z.string().max(200)).max(50),reader_count:z.number().int().nonnegative(),
  }).strict().nullable(),
  /** The choice saved on the card, when it is still exactly an available model of its configuration (as acceptance checks it). */
  selected:GmailApplicationExecutionSelectionSchema.nullable(),
  /**
   * One page of the configurations, in one fixed order: the Project's Assistant first (so always on the first page), then
   * the Project's Agents in the order they were added, each with every profile; a configuration is never split across
   * pages. At most 200 rows (a configuration and each of its models count one), at least one configuration, and on the
   * first page also the chosen configuration when it is on a later page.
   */
  configurations:z.array(GmailApplicationExecutionConfigurationSchema).max(201),
  /** Where the next page starts (`cursor`), or null when this is the last: no configuration is beyond reach. */
  next_cursor:applicationExecutionCursor.nullable(),
  /** The whole card's text as it stands now (for a combined card, every part), redrawn when the owner chooses. */
  summary:z.string().max(8000).nullable(),
  /**
   * The card's revision as shown here (`proposal.accept` `expected_revision`): acceptance is refused once the card
   * changed since — a choice saved in another tab or still being saved — so what is accepted is what was shown.
   */
  card_revision:z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * Only on a `models_of` answer: the model its `models_cursor` continued after is no longer listed, so no place is known
   * to follow what was shown; the configuration's models are given from the first again (with the saved one), and the
   * client replaces that configuration's models with these instead of appending them.
   */
  models_restarted:z.literal(true).optional(),
}).strict();
export type GmailApplicationExecutionOptions=z.infer<typeof GmailApplicationExecutionOptionsOutputSchema>;
export const GmailApplicationExecutionSelectInputSchema=GmailApplicationExecutionSelectionSchema.extend({proposal_id:id}).strict();

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
  'source.gmail.application_updates.execution_options':{input:GmailApplicationExecutionOptionsInputSchema,output:GmailApplicationExecutionOptionsOutputSchema},
  'source.gmail.application_updates.select_execution':{input:GmailApplicationExecutionSelectInputSchema,output:GmailApplicationExecutionOptionsOutputSchema},
  'source.gmail.digest.set_time':{input:GmailDigestSetTimeInputSchema,output:GmailDigestSetStatusOutputSchema},
  'source.gmail.digest.end':{input:GmailDigestEndInputSchema,output:GmailDigestEndOutputSchema},
  'source.gmail.connection.set_agent_read':{input:GmailConnectionSetAgentReadInputSchema,output:GmailConnectionSetAgentReadOutputSchema},
  'source.gmail.mail.read':{input:GmailAgentReadInputSchema,output:GmailAgentReadOutputSchema},
  'source.gmail.delegated.read':{input:GmailDelegatedReadInputSchema,output:GmailAgentReadOutputSchema},
  'source.gmail.delegation.revoke':{input:GmailDelegationRevokeInputSchema,output:GmailDelegationRevokeOutputSchema},
  'source.gmail.connection.disconnect':{input:GmailConnectionTargetSchema,output:GmailConnectionDisconnectOutputSchema},
  'source.gmail.connection.forget':{input:GmailConnectionTargetSchema,output:GmailConnectionForgetOutputSchema},
  'source.gmail.selection.remove':{input:GmailSelectionRemoveInputSchema,output:GmailSelectionRemoveOutputSchema},
  'source.gmail.monitor.set_status':{input:GmailMonitorSetStatusInputSchema,output:GmailMonitorSetStatusOutputSchema},
  'source.gmail.monitor.delete':{input:GmailMonitorDeleteInputSchema,output:GmailMonitorDeleteOutputSchema},
} as const;
