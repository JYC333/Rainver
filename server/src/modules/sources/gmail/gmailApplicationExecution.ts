/**
 * The Agent and model an application-update automation runs on, chosen by the mailbox owner on its card (ADR 0036).
 *
 * - **Two levels.** A configuration is an Agent the owner may use in the Project — the Agents on its list that the owner
 *   can read, and the Project's own Assistant — with one runtime profile the owner can run in their own private
 *   conversation of the Project (`listOptions` for the owner: Host ownership and liveness, installation). Its models are
 *   the ones that conversation offers (ADR 0037): every option of the runtime's own model picker as the Host reports
 *   it — a full id, an alias or `default`, whatever the runtime — or, without a picker, the runtime's own default; and a
 *   ModelProvider profile's lease model, when production admits and leases it (`providerConfiguration`). No runtime is
 *   asked to prove which model answers. A configuration that cannot run the automation at all carries its one reason
 *   and no models; nothing unavailable is selectable. It then runs as that conversation's turns run (no other launch).
 * - **Independent of the conversation it was asked in.** The card is drafted even when that conversation's own binding
 *   could never run the automation; its default is the existing automation's configuration, else that conversation's,
 *   else the first available model of the Project's Agents, else its Assistant's, else none. The automation then always
 *   runs in the owner's private execution conversation bound exactly to what was confirmed (`ensureApplicationExecutionConversation`).
 * - **Choosing is the owner's alone.** `source.gmail.application_updates.execution_options` shows the owner, on their own
 *   pending card, the scope (mailbox, what is read, what may change, who reads the results) and the configurations;
 *   `.select_execution` rechecks the configuration and model now and redraws the pending card in place
 *   (`revisePendingPayload`). Nothing runs until the owner accepts; acceptance rechecks the choice again and freezes it
 *   (`gmailDigests.ts`). Changing it later is a new card.
 * - **One check.** Whether a choice can run it is decided in one place for the default, the echo of the saved choice,
 *   a selection and acceptance (`applicationExecutionCheck`): that one Agent's configurations, by itself — never by its
 *   place in the list the card shows — and, for a saved binding, its exact binding.
 * - **What was shown is what is accepted.** Both queries return the card's revision (`proposalRevisionSql`), which
 *   acceptance must name; both require a pending card, the owner's Project read and write access and the audience the card names.
 * - **Every configuration can be reached.** The list is paged in one fixed order — the Project's Assistant first (so it is
 *   on the first page, whatever the length of the Project's Agent list), then the Project's Agents in the order they were
 *   added, each with every profile — at most 200 rows (a configuration and each of its models one each, a configuration
 *   never split) and 50 Agents a page; `next_cursor` continues it (`execution_options` `cursor`). The cursor names the
 *   Agent the next page starts at by its sort key, not its position: an Agent removed from an earlier page between pages
 *   skips no later configuration.
 */
import {
  GMAIL_APPLICATION_EXECUTION_MODELS_PER_CONFIGURATION, GmailDigestProposalPayloadSchema, GmailSetupProposalPayloadSchema,
  type GmailApplicationExecutionConfiguration, type GmailApplicationExecutionOptions, type GmailApplicationExecutionReason,
  type GmailApplicationExecutionModel, type GmailApplicationExecutionSelection, type GmailDigestProposalPayload, type GmailDigestRuntimeBinding, type OperationActor,
  type OperationInput, type RegisteredSystemActionDefinition,
} from "@rainver/protocol";
import { contentReadSql } from "../../access/contentAccessSql.js";
import { canReadProject, canWriteProject } from "../../projects/access.js";
import { proposalRevisionSql } from "../../proposals/proposalRevision.js";
import type { Queryable } from "../../routeUtils/common.js";
import { hidden, OperationError, OperationRefusal } from "../../systemActions/operations/errors.js";
import type { OperationRegistration } from "../../systemActions/operations/types.js";
import { gmailCardAudienceCovers } from "./gmailApplicationSharedConversation.js";
import { applicationExecutionKey, applicationModelChoice, currentApplicationUpdateRuntime, explicitModel, RUNTIME_DEFAULT_MODEL_CHOICE } from "./gmailApplicationUpdateRuns.js";

/** One page of the card's configurations: at most this many rows (a configuration and each of its models), from at most this many Agents. */
const PAGE_ROWS = 200;
const PAGE_AGENTS = 50;

/** One configuration as the card lists it, and the binding its private execution conversation will hold for each model that can run it. */
export interface ApplicationExecutionConfiguration {
  configuration: GmailApplicationExecutionConfiguration;
  /** Every model that can run it, listed or not (a configuration lists at most 200 at a time): a choice is checked against all of them. */
  bindings: ReadonlyMap<string, GmailDigestRuntimeBinding>;
  /** Every model of it in the card's order, listed or not, with why one cannot be chosen. */
  allModels: readonly GmailApplicationExecutionModel[];
  /** Its models were asked from a cursor whose model is gone, so they are listed from the first again (`modelPage`). */
  modelsRestarted?: boolean;
}
/** Where the next models of one configuration start (`models_cursor`): after the model listed last, at its place. */
interface ModelsCursor { index: number; model: string }
/** How a configuration's models are listed: the saved model always, and one configuration's from a cursor. */
interface ConfigurationView {
  selected?: { runtime_profile_id: string; model: string } | null;
  modelsFrom?: { runtime_profile_id: string; cursor: ModelsCursor } | null;
}
const modelsCursorText = (cursor: ModelsCursor) => `${cursor.index}.${Buffer.from(cursor.model, "utf8").toString("base64url")}`;
function parseModelsCursor(text: string): ModelsCursor | null {
  const match = /^(\d{1,6})\.([A-Za-z0-9_-]{1,400})$/.exec(text);
  return match ? { index: Number(match[1]), model: Buffer.from(match[2]!, "base64url").toString("utf8") } : null;
}

/**
 * One page of a configuration's models: from the start, or after the model a cursor names — found again by its id, so a
 * model removed or added before it meanwhile skips nothing. When that model itself is gone, no place in the list is known
 * to follow what was shown (its old index now names a later model), so the page starts over from the first model
 * (`restarted`) and the client lists that configuration's models afresh instead of appending. At most 200; the saved model
 * is listed on a first page whatever its place (one more), so the choice the card echoes is always on it.
 */
function modelPage(all: readonly GmailApplicationExecutionModel[], from: ModelsCursor | null, selected: string | null) {
  let start = 0;
  let restarted = false;
  if (from) {
    start = all[from.index - 1]?.model === from.model ? from.index : all.findIndex((entry) => entry.model === from.model) + 1;
    restarted = start === 0;
  }
  const first = !from || restarted;
  const shown = all.slice(start, start + GMAIL_APPLICATION_EXECUTION_MODELS_PER_CONFIGURATION);
  const end = start + shown.length;
  const savedModel = first && selected && !shown.some((entry) => entry.model === selected) ? all.find((entry) => entry.model === selected) : undefined;
  return {
    page: {
      models: savedModel ? [savedModel, ...shown] : shown,
      omitted_models: all.length - end,
      models_cursor: end < all.length && end > 0 ? modelsCursorText({ index: end, model: all[end - 1]!.model }) : null,
    },
    restarted,
  };
}
/**
 * Where a page starts in the card's order (the Project's Assistant first, then its Agents in the order they were added):
 * the Agent it starts at, by its sort key — `phase` (0 the Assistant, 1 the Project's Agents), `key` (when it was
 * created or added, UTC microseconds as 20 digits) and its id — and the index of that Agent's configuration. Keyed, not an
 * offset: the next page starts at the first Agent at or after that key, so an Agent removed from an earlier page shifts
 * nothing; when the named Agent itself is gone, the next one starts at its first configuration. Only within one Agent's
 * own configurations (more than a page of profiles) is `row` positional; a choice is checked by itself anyway.
 */
export interface ApplicationExecutionCursor { phase: 0 | 1; key: string; agent: string; row: number }
/** One page of the configurations a card lists, and where the next one starts (null: none; nothing is silently dropped). */
export interface ApplicationExecutionList { configurations: ApplicationExecutionConfiguration[]; next: ApplicationExecutionCursor | null }

/** The wire form of a cursor (`execution_options` `cursor`, `next_cursor`). */
export const applicationExecutionCursorText = (cursor: ApplicationExecutionCursor) =>
  `${cursor.phase}.${cursor.key}.${Buffer.from(cursor.agent, "utf8").toString("base64url")}.${cursor.row}`;
/** The cursor a page's `next_cursor` names; none (the first page) when omitted. The wire schema has checked its form. */
export function parseApplicationExecutionCursor(text: string | undefined): ApplicationExecutionCursor | null {
  const match = text ? /^([01])\.(\d{20})\.([A-Za-z0-9_-]{1,96})\.(\d{1,6})$/.exec(text) : null;
  if (!match) return null;
  return { phase: match[1] === "1" ? 1 : 0, key: match[2]!, agent: Buffer.from(match[3]!, "base64url").toString("utf8"), row: Number(match[4]) };
}
export interface ApplicationExecutionScope { spaceId: string; ownerUserId: string; projectId: string; draftingSessionId: string | null }

/** Why a choice cannot run it: its configuration's reason, or that it is not offered at all (any more). */
export type ApplicationExecutionRefusal = GmailApplicationExecutionReason | "not_offered";

const REASON_TEXT: Record<ApplicationExecutionRefusal, string> = {
  agent_unavailable: "this Agent is disabled",
  no_runtime: "this Agent has no runtime you can run in your own private conversation of this Project",
  host_not_owner: "its runtime is on another person's Host, so your mail would leave your reach",
  host_offline: "its execution Host is offline",
  runtime_unavailable: "its runtime is not ready on its Host",
  model_unresolved: "its ModelProvider names no explicit model",
  provider_unsupported: "this runtime cannot be bound to a ModelProvider",
  provider_unavailable: "its ModelProvider cannot be used in this Space now (disabled, not granted here, a personal subscription, or without a usable key)",
  provider_protocol_unsupported: "its ModelProvider speaks no protocol this runtime can use",
  provider_endpoint_missing: "its ModelProvider has no compatible endpoint URL for this runtime",
  not_offered: "it is not offered for this Project now",
};

/** Why a choice cannot run the automation, in a sentence for the owner. */
export const applicationExecutionReasonText = (reason: ApplicationExecutionRefusal) => REASON_TEXT[reason];

type AgentRow = { id: string; name: string; agent_kind: "standard" | "system_assistant"; status: string; sort_key: string };

/** An Agent's sort key in the card's order: a timestamp as UTC microseconds, 20 digits, so text order is time order. */
const sortKeySql = (timestamp: string) => `to_char((${timestamp}) AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS')`;

/**
 * The Agents the owner may use in the Project, in the card's order from the Agent `from` names (or the next one after
 * it, when it is gone), at most `limit`: its own Assistant first (always on the first page, never displaced by the
 * list's length), then the Agents on its list the owner can read, in the order they were added. `only` evaluates
 * exactly that one of them, so a choice is checked by itself — never by where it falls in the list.
 */
async function usableAgents(db: Queryable, input: ApplicationExecutionScope, only: string | null, from: ApplicationExecutionCursor | null = null, limit: number | null = null): Promise<AgentRow[]> {
  // Ties of the key are broken by id, compared bytewise ("C") in the filter and the order alike.
  const after = (phase: 0 | 1, key: string, keyParam: string, idParam: string) =>
    from && from.phase === phase ? `AND (${key}, s.id COLLATE "C") >= (${keyParam}::text, ${idParam}::text COLLATE "C")` : "";
  const keyed = (phase: 0 | 1) => (from && from.phase === phase ? [from.key, from.agent] : []);
  const assistants = from?.phase === 1 ? [] : (await db.query<AgentRow>(
    `SELECT s.* FROM (SELECT a.id,a.name,a.agent_kind,a.status,${sortKeySql("a.created_at")} AS sort_key FROM agents a
      WHERE a.space_id=$1 AND a.project_id=$2 AND a.agent_kind='system_assistant' AND a.status='active' AND ($3::varchar IS NULL OR a.id=$3)) s
      WHERE true ${after(0, "s.sort_key", "$4", "$5")}
      ORDER BY s.sort_key, s.id COLLATE "C"`, [input.spaceId, input.projectId, only, ...keyed(0)])).rows;
  const head = limit === null ? assistants : assistants.slice(0, limit);
  const room = limit === null ? null : limit - head.length;
  if (room === 0) return head;
  const tail = [...keyed(1), ...(room === null ? [] : [room])];
  const standard = (await db.query<AgentRow>(
    `SELECT s.* FROM (SELECT a.id,a.name,a.agent_kind,a.status,
             ${sortKeySql("SELECT min(l.created_at) FROM project_agent_links l WHERE l.space_id=a.space_id AND l.project_id=$2 AND l.agent_id=a.id AND l.status='active'")} AS sort_key
        FROM agents a WHERE a.space_id=$1 AND ($4::varchar IS NULL OR a.id=$4) AND a.agent_kind='standard' AND a.status<>'archived'
         AND EXISTS (SELECT 1 FROM project_agent_links l WHERE l.space_id=a.space_id AND l.project_id=$2 AND l.agent_id=a.id AND l.status='active')
         AND ${contentReadSql("agent", "a", "$3")}) s
      WHERE true ${after(1, "s.sort_key", "$5", "$6")}
      ORDER BY s.sort_key, s.id COLLATE "C"
      ${room === null ? "" : `LIMIT $${5 + keyed(1).length}`}`,
    [input.spaceId, input.projectId, input.ownerUserId, only, ...tail])).rows;
  return [...head, ...standard];
}

/** The lease's own refusal codes (`providerLeaseTarget`), as the card says them. */
function leaseRefusalReason(code: string): GmailApplicationExecutionReason {
  if (code === "adapter_provider_binding_unsupported") return "provider_unsupported";
  if (code === "model_provider_not_found") return "provider_unavailable";
  if (code === "provider_protocol_unsupported") return "provider_protocol_unsupported";
  return code.endsWith("_base_url_required") ? "provider_endpoint_missing" : "provider_unavailable";
}

/**
 * The one model a ModelProvider configuration runs on, or why it cannot run the automation — checked as production
 * checks it, never by a second rule (ADR 0036 §9): Profile admission (`assertBackendModeBinding`: the runtime binds a
 * ModelProvider at all, and the Profile names its model), the Provider's eligibility for the owner as conversation and
 * routing judge it (`isProviderEligibleForUser`: enabled, granted here, not someone's subscription, a usable key), the
 * lease's own target (`providerLeaseTarget`, read as the lease reads the Provider: protocol and compatible URL, and the
 * model it resolves). It then launches as the conversation launches it (ADR 0037): the lease holds the model.
 */
async function providerConfiguration(db: Queryable, input: ApplicationExecutionScope, profile: {
  runtime_key: string; model_provider_id: string | null; model_name: string | null;
}): Promise<{ model: string; reason: null } | { model: null; reason: GmailApplicationExecutionReason }> {
  // Imported when needed: the admission and lease modules reach the digest module, which imports this one.
  const [{ assertBackendModeBinding }, { supportsRuntimeBackendMode }, { providerLeaseTarget, RemoteProviderBindingError },
    { isProviderEligibleForUser, providerCredentialEligibilitySql }, { providersDbPortIn }] = await Promise.all([
    import("../../agents/runtimeProfileAdmission.js"), import("../../runtimeAdapters/runtimeDefinitions.js"), import("../../runs/remoteProviderBinding.js"),
    import("../../providers/eligibility.js"), import("../../providers/dbReader.js")]);
  try {
    assertBackendModeBinding(profile.runtime_key, "model_provider", profile.model_provider_id, profile.model_name);
  } catch {
    return { model: null, reason: supportsRuntimeBackendMode(profile.runtime_key, "model_provider") ? "model_unresolved" : "provider_unsupported" };
  }
  const eligibility = (await db.query<{
    provider_type: string | null; provider_enabled: boolean | null; provider_grant_enabled: boolean | null; provider_owner_user_id: string | null;
    provider_credential_type: string | null; provider_has_eligible_credential: boolean | null;
  }>(`SELECT provider.provider_type, provider.enabled AS provider_enabled, provider_grant.enabled AS provider_grant_enabled,
             provider.owner_user_id AS provider_owner_user_id, provider_credential.credential_type AS provider_credential_type,
             ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")} AS provider_has_eligible_credential
        FROM model_providers provider
        LEFT JOIN model_provider_space_grants provider_grant ON provider_grant.provider_id = provider.id AND provider_grant.space_id = $1
        LEFT JOIN credentials provider_credential ON provider_credential.id = provider.credential_id
       WHERE provider.id = $2`, [input.spaceId, profile.model_provider_id])).rows[0];
  if (!eligibility || !isProviderEligibleForUser(eligibility, input.ownerUserId)) return { model: null, reason: "provider_unavailable" };
  // `userId: null`, as the lease reads it: no subscription Provider.
  const record = await providersDbPortIn(db).getProvider(input.spaceId, null, profile.model_provider_id!);
  let model: string | null;
  try {
    model = providerLeaseTarget(profile.runtime_key, record && typeof record === "object" ? record as Record<string, unknown> : null, { model: profile.model_name }).model;
  } catch (error) {
    if (error instanceof RemoteProviderBindingError) return { model: null, reason: leaseRefusalReason(error.code) };
    throw error;
  }
  const explicit = explicitModel(model);
  return explicit ? { model: explicit, reason: null } : { model: null, reason: "model_unresolved" };
}

/**
 * Every configuration of one Agent, in a fixed order (its profiles as the owner's private conversation lists them),
 * each with the models that conversation's picker offers. Why a configuration cannot run it at all is judged once for
 * it: first a ModelProvider configuration production would refuse, then whether the owner's own private conversation
 * can run it now (another person's Host, offline, not ready).
 * `view` lists the saved model on the first page of its configuration's models, and one configuration's from a cursor.
 */
async function agentConfigurations(db: Queryable, input: ApplicationExecutionScope, agent: AgentRow, view: ConfigurationView = {}): Promise<ApplicationExecutionConfiguration[]> {
  const base = { agent_id: agent.id, agent_name: agent.name.slice(0, 200), agent_kind: agent.agent_kind };
  const none = (reason: GmailApplicationExecutionReason): ApplicationExecutionConfiguration[] => [{
    configuration: { ...base, runtime_profile_id: null, profile_name: null, runtime_key: null, backend_mode: null, available: false, reason, models: [], omitted_models: 0, models_cursor: null },
    bindings: new Map(), allModels: [] }];
  if (agent.status !== "active") return none("agent_unavailable");
  // Imported when needed: the sessions module reaches the plugin data tools, which import the digest module.
  const { PgConversationBackendRepository } = await import("../../sessions/conversationBackendRepository.js");
  const options = await new PgConversationBackendRepository(db as never).listOptions(input.spaceId, input.ownerUserId, agent.id, input.projectId);
  if (!options.length) return none("no_runtime");
  const saved = input.draftingSessionId ? await currentApplicationUpdateRuntime(db, { spaceId: input.spaceId, sessionId: input.draftingSessionId, agentId: agent.id }) : null;
  const configurations: ApplicationExecutionConfiguration[] = [];
  for (const option of options) {
    const profile = (await db.query<{ runtime_key: string; backend_mode: "runtime_native" | "model_provider"; model_name: string | null; model_provider_id: string | null }>(
      `SELECT runtime_key,backend_mode,model_name,model_provider_id FROM agent_runtime_profiles WHERE id=$1 AND space_id=$2 AND agent_id=$3 AND enabled`,
      [option.runtime_profile_id, input.spaceId, agent.id])).rows[0];
    if (!profile) continue;
    const row = { ...base, runtime_profile_id: option.runtime_profile_id, profile_name: option.name.slice(0, 200), runtime_key: profile.runtime_key, backend_mode: profile.backend_mode };
    // Each model's option (its picker id, none for the runtime's own default) and the picker's name for it.
    const offered = new Map<string, { optionId: string | null; name: string | null }>();
    let reason: GmailApplicationExecutionReason | null = null;
    if (profile.backend_mode === "model_provider") {
      // The fixed-model lease: built only for the one model it resolves to and held to it (ADR 0034 §3).
      const checked = await providerConfiguration(db, input, profile);
      if (checked.model) offered.set(checked.model, { optionId: null, name: null }); else reason = checked.reason;
    } else {
      // Exactly what the conversation's model picker offers, in its order (ADR 0037).
      const picker = option.session_config_options?.find((entry) => entry.category === "model" && entry.type === "select");
      if (picker && picker.type === "select") {
        for (const choice of picker.options) {
          if (typeof choice.value === "string" && choice.value.trim() && !offered.has(choice.value.slice(0, 255)))
            offered.set(choice.value.slice(0, 255), { optionId: picker.id, name: typeof choice.name === "string" && choice.name.trim() ? choice.name.slice(0, 200) : null });
        }
      }
      // A model saved for it in the asking conversation is offered too: the Host's cached picker can be stale (the
      // live session then decides, as for any requested model).
      const savedModel = saved?.runtime_profile_id === option.runtime_profile_id ? saved.session_config.find((entry) => entry.category === "model") : undefined;
      if (savedModel && typeof savedModel.value === "string" && savedModel.value.trim() && !offered.has(savedModel.value.slice(0, 255)))
        offered.set(savedModel.value.slice(0, 255), { optionId: savedModel.id, name: null });
      // No model option at all: the conversation runs on the runtime's own default, and so does this.
      if (!offered.size) offered.set(RUNTIME_DEFAULT_MODEL_CHOICE, { optionId: null, name: null });
    }
    // The owner's own private conversation must be able to run it: never another person's Host, never one offline.
    reason ??= option.usable !== false ? null
      : option.host_owner_is_me === false ? "host_not_owner" : option.host_online === false ? "host_offline" : "runtime_unavailable";
    const bindings = new Map<string, GmailDigestRuntimeBinding>();
    if (reason === null) {
      for (const [model, entry] of offered) {
        bindings.set(model, {
          runtime_profile_id: option.runtime_profile_id, runtime_key: profile.runtime_key, backend_mode: profile.backend_mode,
          model_provider_id: profile.model_provider_id, model_name: profile.model_name,
          session_config: entry.optionId === null ? [] : [{ id: entry.optionId, type: "select", value: model, category: "model" }],
          agent_name: base.agent_name, model_label: `${entry.name ?? model} (${option.name})`.slice(0, 300), pinned_model: model,
          // Launched as the conversation launches its turns (ADR 0037), not isolated to a lease as earlier cards said.
          conversation_launch: true,
        });
      }
    }
    const allModels: GmailApplicationExecutionModel[] = reason !== null ? [] : [...offered].map(([model, entry]) => ({ model, name: entry.name }));
    const here = (entry: { runtime_profile_id: string } | null | undefined) => entry?.runtime_profile_id === option.runtime_profile_id;
    const { page, restarted } = modelPage(allModels, here(view.modelsFrom) ? view.modelsFrom!.cursor : null, here(view.selected) ? view.selected!.model : null);
    configurations.push({ configuration: { ...row, available: reason === null, reason, ...page }, bindings, allModels, ...(restarted ? { modelsRestarted: true } : {}) });
  }
  return configurations;
}

/** What one configuration takes of a page: itself and each listed model. */
const rowsOf = (entry: ApplicationExecutionConfiguration) => 1 + entry.configuration.models.length;

/**
 * One page of every configuration for the owner in this Project, available or not, as the card lists them, from
 * `cursor` (the first page when omitted). A configuration is never split: a page takes whole configurations up to 200
 * rows, and always at least one. A choice is never checked against this list but by itself (`applicationExecutionCheck`).
 */
export async function applicationExecutionConfigurations(db: Queryable, input: ApplicationExecutionScope, cursor: ApplicationExecutionCursor | null = null,
  view: ConfigurationView = {}): Promise<ApplicationExecutionList> {
  // One Agent more than a page takes, to know whether another page follows.
  const agents = await usableAgents(db, input, null, cursor, PAGE_AGENTS + 1);
  const at = (agent: AgentRow, row: number): ApplicationExecutionCursor =>
    ({ phase: agent.agent_kind === "system_assistant" ? 0 : 1, key: agent.sort_key, agent: agent.id, row });
  const configurations: ApplicationExecutionConfiguration[] = [];
  let rows = 0;
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!;
    if (index === PAGE_AGENTS) return { configurations, next: at(agent, 0) };
    const own = await agentConfigurations(db, input, agent, view);
    // The row applies only to the Agent the cursor names; when that one is gone, the next starts at its first configuration.
    const start = index === 0 && cursor?.agent === agent.id ? Math.min(cursor.row, own.length) : 0;
    for (let row = start; row < own.length; row += 1) {
      const entry = own[row]!;
      // The page is full: this configuration, whole, starts the next page.
      if (configurations.length > 0 && rows + rowsOf(entry) > PAGE_ROWS) return { configurations, next: at(agent, row) };
      configurations.push(entry);
      rows += rowsOf(entry);
    }
  }
  return { configurations, next: null };
}

/**
 * Whether a choice can run the automation now, checked by itself for its one Agent — never by its place in the card's
 * list — in the one place every caller asks it: the card's default, the echo of its saved choice, a selection and
 * acceptance. `wanted` names a configuration and model (a selection), and with `binding` also the exact binding it must
 * still have (what a card saved or an automation froze). Returns that configuration and the binding the owner's private
 * execution conversation will hold, else why not: the configuration's own reason (which holds for any model of it), or
 * that it is not offered (any more, or with another binding — also a ModelProvider binding a card froze while such a
 * configuration ran isolated to its lease, ADR 0036 §9: its owner chooses again on a card that says how it runs now).
 */
export async function applicationExecutionCheck(db: Queryable, input: ApplicationExecutionScope, wanted: {
  agent_id: string; runtime_profile_id: string; model: string; binding?: GmailDigestRuntimeBinding;
}): Promise<{ configuration: ApplicationExecutionConfiguration | null; binding: GmailDigestRuntimeBinding | null; reason: ApplicationExecutionRefusal | null }> {
  const own: ApplicationExecutionConfiguration[] = [];
  // The wanted model is listed with its configuration whatever its place among its models (`modelPage`).
  const view: ConfigurationView = { selected: { runtime_profile_id: wanted.runtime_profile_id, model: wanted.model } };
  for (const agent of await usableAgents(db, input, wanted.agent_id)) own.push(...await agentConfigurations(db, input, agent, view));
  // An Agent that cannot run it at all is listed without a profile: its reason holds for any profile asked for.
  const configuration = own.find((entry) => entry.configuration.runtime_profile_id === wanted.runtime_profile_id)
    ?? own.find((entry) => entry.configuration.runtime_profile_id === null) ?? null;
  if (!configuration) return { configuration: null, binding: null, reason: "not_offered" };
  if (configuration.configuration.reason) return { configuration, binding: null, reason: configuration.configuration.reason };
  const binding = configuration.bindings.get(wanted.model) ?? null;
  if (!binding) return { configuration, binding: null, reason: "not_offered" };
  // A saved choice frozen before cards said how it launches (no `conversation_launch`, any backend) is chosen again (ADR 0037 §6).
  if (wanted.binding && (applicationExecutionKey(wanted.binding) !== applicationExecutionKey(binding)
    || wanted.binding.conversation_launch !== true)) return { configuration, binding: null, reason: "not_offered" };
  return { configuration, binding, reason: null };
}

/** The saved choice a binding names, for `applicationExecutionCheck`. */
export const savedExecutionChoice = (agentId: string, binding: GmailDigestRuntimeBinding) =>
  ({ agent_id: agentId, runtime_profile_id: binding.runtime_profile_id, model: applicationModelChoice(binding) ?? "", binding });

/** The first model of a page that can run it — the Project's own Agents' before its Assistant's — or none. */
function firstAvailable(listed: ApplicationExecutionList): { agentId: string; binding: GmailDigestRuntimeBinding } | null {
  for (const kind of ["standard", "system_assistant"] as const) {
    for (const entry of listed.configurations) {
      const binding = entry.configuration.agent_kind === kind ? entry.bindings.values().next().value : undefined;
      if (binding) return { agentId: entry.configuration.agent_id, binding };
    }
  }
  return null;
}

/**
 * The card's default: the first of `preferred` (the existing automation's configuration, then the drafting
 * conversation's) that is still an available model with exactly that configuration — each checked by itself — else the first
 * available model of the Project's own Agents on the first page, else its Assistant's, else none: the Assistant is the
 * default when no Agent of the Project's can run it.
 */
export async function defaultApplicationExecution(db: Queryable, input: ApplicationExecutionScope, listed: ApplicationExecutionList,
  preferred: readonly ({ agentId: string; binding: GmailDigestRuntimeBinding | null } | null)[]): Promise<{ agentId: string; binding: GmailDigestRuntimeBinding } | null> {
  for (const wanted of preferred) {
    if (!wanted?.binding) continue;
    // Only a default: the card then shows, and the owner accepts, how that configuration runs now.
    const checked = await applicationExecutionCheck(db, input, savedExecutionChoice(wanted.agentId, { ...wanted.binding, conversation_launch: true }));
    if (checked.binding) return { agentId: wanted.agentId, binding: checked.binding };
  }
  return firstAvailable(listed);
}

// ---------------------------------------------------------------------------
// The owner's card: what it shows and how a choice redraws it
// ---------------------------------------------------------------------------

interface CardRow { id: string; proposal_type: string; status: string; expired: boolean; owner_user_id: string | null; visibility: string; payload_json: unknown; revision: string }
type Card = { row: CardRow; kind: "digest"; payload: GmailDigestProposalPayload; part: GmailDigestProposalPayload }
  | { row: CardRow; kind: "setup"; payload: ReturnType<typeof GmailSetupProposalPayloadSchema.parse>; part: GmailDigestProposalPayload | null };

/** The owner's own application-update card (or combined card), or the hidden 404. */
async function ownerCard(db: Queryable, actor: OperationActor, proposalId: string): Promise<Card> {
  if (actor.principal.kind !== "user" || !actor.on_behalf_of_user_id) throw hidden();
  const row = (await db.query<CardRow>(
    `SELECT p.id,p.proposal_type,p.status,(p.expires_at IS NOT NULL AND p.expires_at<=now()) AS expired,p.owner_user_id,p.visibility,p.payload_json,
            ${proposalRevisionSql("p")} AS revision
       FROM proposals p WHERE p.id=$1 AND p.space_id=$2 AND p.proposal_type IN ('gmail_digest_create','gmail_setup')`, [proposalId, actor.space_id])).rows[0];
  if (!row || row.owner_user_id !== actor.on_behalf_of_user_id || row.visibility !== "private") throw hidden();
  if (row.proposal_type === "gmail_setup") {
    const payload = GmailSetupProposalPayloadSchema.safeParse(row.payload_json);
    if (!payload.success) throw hidden();
    return { row, kind: "setup", payload: payload.data, part: payload.data.parts.find((part) => part.kind === "application") ?? null };
  }
  const payload = GmailDigestProposalPayloadSchema.safeParse(row.payload_json);
  if (!payload.success || payload.data.kind !== "application") throw hidden();
  return { row, kind: "digest", payload: payload.data, part: payload.data };
}

const pendingConflict = () => new OperationRefusal(409, "gmail", "This card was already decided or has expired. Ask for a new one in conversation.", { code: "gmail_card_not_pending" });

/** The owner's Project access the card's scope rests on: reading it (else the hidden 404), and still editing it. */
async function assertProjectAccess(db: Queryable, actor: OperationActor, part: GmailDigestProposalPayload): Promise<void> {
  // Its Agents, runtimes and applications are the Project's: only while the owner still reads it.
  if (!await canReadProject(db, actor.space_id, part.project_id, actor.on_behalf_of_user_id!)) throw hidden();
  // The automation changes the Project's applications as the owner, as drafting required (`proposeGmailApplicationUpdates`).
  if (!await canWriteProject(db, actor.space_id, part.project_id, actor.on_behalf_of_user_id!))
    throw new OperationRefusal(409, "gmail", "You can no longer edit this Project's applications, so this card cannot be set up. Ask for a new one once you can.", { code: "gmail_digest_applications_unavailable" });
}

/**
 * What the card shows still holds before it is shown or changed: the owner's Project access, and the conversation it
 * was drafted in is still one whose readers the card names — the owner's private conversation, or a Room or the
 * mainline whose every reader now was shown on it (a reader added since never saw what they will read, ADR 0035 §1).
 */
async function assertCardScopeCurrent(db: Queryable, actor: OperationActor, part: GmailDigestProposalPayload): Promise<void> {
  await assertProjectAccess(db, actor, part);
  // Imported when needed: the digest module imports this one.
  const { gmailDigestConversationAdmits } = await import("./gmailDigests.js");
  const shared = part.shared_conversation === true;
  const conversation = await gmailDigestConversationAdmits(db, { spaceId: actor.space_id, ownerUserId: actor.on_behalf_of_user_id!, projectId: part.project_id, sessionId: part.session_id, ownerOnly: !shared });
  if (!conversation || (shared && (!conversation.roomId || !gmailCardAudienceCovers(part.audience, conversation.readers))))
    throw new OperationRefusal(409, "gmail", "Someone can read the conversation this card was drafted in who is not shown on it, or it is no longer a conversation of this Project. Ask for a new card there.", { code: "gmail_digest_audience_changed" });
}

function scopeOf(part: GmailDigestProposalPayload): NonNullable<GmailApplicationExecutionOptions["scope"]> {
  const audience = part.audience ?? null;
  return {
    mailbox_email: part.mailbox_email, effects: part.effects ?? [], ...(part.include_sent ? { include_sent: part.include_sent } : {}),
    results_to: audience ? audience.kind : "private", room_title: audience?.room_title ?? null,
    reader_names: audience?.reader_names ?? [], reader_count: audience?.reader_user_ids.length ?? 0,
  };
}

/**
 * The choice saved on the card when it is still exactly an available model of its configuration — the same check
 * acceptance makes, so a card that shows a choice is one that can be accepted on it — with that configuration.
 */
async function savedChoice(db: Queryable, scope: ApplicationExecutionScope, part: GmailDigestProposalPayload): Promise<{
  selection: GmailApplicationExecutionSelection; configuration: ApplicationExecutionConfiguration;
} | null> {
  const binding = part.runtime_binding;
  if (!binding?.pinned_model) return null;
  const checked = await applicationExecutionCheck(db, scope, savedExecutionChoice(part.agent_id, binding));
  return checked.binding?.pinned_model && checked.configuration
    ? { selection: { agent_id: part.agent_id, runtime_profile_id: binding.runtime_profile_id, model: checked.binding.pinned_model }, configuration: checked.configuration }
    : null;
}

/**
 * Whether the card changes an existing automation: the one it was drafted against (`replaces_digest_id`, frozen with its
 * version); a card drafted before cards froze it says so while one is live for this mailbox and Project.
 */
async function changesExisting(db: Queryable, part: GmailDigestProposalPayload): Promise<boolean> {
  if (part.replaces_digest_id !== undefined) return part.replaces_digest_id !== null;
  return (await db.query(`SELECT 1 FROM gmail_digests WHERE gmail_connection_id=$1 AND project_id=$2 AND kind='application' AND status<>'ended'`,
    [part.connection_id, part.project_id])).rows.length > 0;
}

/** The card's text for an application part as it stands, and for a combined card the whole card with that part. */
async function cardSummaries(db: Queryable, card: Card, part: GmailDigestProposalPayload): Promise<{ part: string; card: string }> {
  const { applicationUpdatesCardSummary } = await import("./gmailApplicationUpdates.js");
  const partText = applicationUpdatesCardSummary({
    mailbox_email: part.mailbox_email, effects: part.effects ?? [], include_sent: part.include_sent, binding: part.runtime_binding ?? null, change: await changesExisting(db, part), audience: part.audience ?? null,
  });
  if (card.kind === "digest") return { part: partText, card: partText };
  const { gmailSetupSummary } = await import("./gmailSetupProposal.js");
  const lines = card.payload.parts.map((entry) => entry.kind === "application" ? partText : entry.card_summary ?? null);
  // A combined card drafted before its parts kept their lines cannot be redrawn; it is drafted again instead.
  if (lines.some((line) => line === null)) throw new OperationRefusal(409, "gmail", "This card cannot be changed here. Ask for a new one in conversation.", { code: "gmail_card_outdated" });
  return { part: partText, card: gmailSetupSummary({ onDemandRead: card.payload.on_demand_read, mailboxEmail: card.payload.mailbox_email, partLines: lines as string[], reused: card.payload.reused, audience: card.payload.audience }) };
}

const scopeFor = (actor: OperationActor, part: GmailDigestProposalPayload): ApplicationExecutionScope =>
  ({ spaceId: actor.space_id, ownerUserId: actor.on_behalf_of_user_id!, projectId: part.project_id, draftingSessionId: part.session_id });

/**
 * A page of configurations; the first page always shows the chosen one too (checked by itself, wherever it falls in the
 * list) — one configuration more than a page when it is on a later one.
 */
function withChosen(listed: ApplicationExecutionList, chosen: ApplicationExecutionConfiguration | null, first: boolean): Pick<GmailApplicationExecutionOptions, "configurations" | "next_cursor"> {
  const configurations = listed.configurations.map((entry) => entry.configuration);
  const shown = !first || !chosen || configurations.some((entry) => entry.agent_id === chosen.configuration.agent_id && entry.runtime_profile_id === chosen.configuration.runtime_profile_id);
  return { configurations: shown ? configurations : [chosen.configuration, ...configurations], next_cursor: listed.next ? applicationExecutionCursorText(listed.next) : null };
}

/** One configuration of one Agent, by itself, as `view` lists its models; null when it is not one of that Agent's now. */
async function configurationOf(db: Queryable, input: ApplicationExecutionScope, agentId: string, runtimeProfileId: string, view: ConfigurationView): Promise<ApplicationExecutionConfiguration | null> {
  for (const agent of await usableAgents(db, input, agentId)) {
    const hit = (await agentConfigurations(db, input, agent, view)).find((entry) => entry.configuration.runtime_profile_id === runtimeProfileId);
    if (hit) return hit;
  }
  return null;
}

async function optionsFor(db: Queryable, actor: OperationActor, card: Card, request: { cursor?: string; models_of?: { agent_id: string; runtime_profile_id: string; models_cursor: string } } = {}): Promise<GmailApplicationExecutionOptions> {
  // Only a card the owner can still decide: a decided or expired card shows no choices.
  if (card.row.status !== "pending" || card.row.expired) throw pendingConflict();
  if (!card.part) return { proposal_id: card.row.id, applies: false, scope: null, selected: null, configurations: [], next_cursor: null, summary: null, card_revision: card.row.revision };
  const part = card.part;
  await assertCardScopeCurrent(db, actor, part);
  const scope = scopeFor(actor, part);
  const saved = await savedChoice(db, scope, part);
  // Every listing shows the saved model with its configuration, whatever its place among that configuration's models.
  const selected = saved ? { runtime_profile_id: saved.selection.runtime_profile_id, model: saved.selection.model } : null;
  const summaries = await cardSummaries(db, card, part).catch(() => null);
  const card_fields = { proposal_id: card.row.id, applies: true, scope: scopeOf(part), selected: saved?.selection ?? null, summary: summaries?.card ?? null, card_revision: card.row.revision };
  if (request.models_of) {
    // More models of one configuration: that configuration alone, checked by itself, from its cursor.
    const from = parseModelsCursor(request.models_of.models_cursor);
    const one = from ? await configurationOf(db, scope, request.models_of.agent_id, request.models_of.runtime_profile_id, { selected, modelsFrom: { runtime_profile_id: request.models_of.runtime_profile_id, cursor: from } }) : null;
    return { ...card_fields, configurations: one ? [one.configuration] : [], next_cursor: null, ...(one?.modelsRestarted ? { models_restarted: true } : {}) };
  }
  const listed = await applicationExecutionConfigurations(db, scope, parseApplicationExecutionCursor(request.cursor), { selected });
  return { ...card_fields, ...withChosen(listed, saved?.configuration ?? null, !request.cursor) };
}

/** The owner's choice on their pending card: rechecked now, by itself, then the card is redrawn in place. Nothing runs yet. */
async function selectExecution(db: Queryable, actor: OperationActor, input: OperationInput<"source.gmail.application_updates.select_execution">): Promise<GmailApplicationExecutionOptions> {
  // The proposal subsystem's order: its transition keys and row lock before anything the card names (as acceptance).
  const { lockProposalTransitions } = await import("../../systemActions/operations/proposalTransitions.js");
  const transitions = await lockProposalTransitions(db, actor.space_id, [input.proposal_id]);
  const card = await ownerCard(db, actor, input.proposal_id);
  if (card.row.status !== "pending" || card.row.expired || transitions.hasLinked(card.row.id)) throw pendingConflict();
  if (!card.part) throw new OperationRefusal(409, "gmail", "This card does not set up application updates.", { code: "gmail_card_not_application" });
  const part = card.part;
  await assertCardScopeCurrent(db, actor, part);
  const scope = scopeFor(actor, part);
  const selection = { agent_id: input.agent_id, runtime_profile_id: input.runtime_profile_id, model: input.model };
  const { configuration, binding, reason } = await applicationExecutionCheck(db, scope, selection);
  if (!binding || !configuration) {
    throw new OperationRefusal(409, "gmail", `This Agent and model cannot run it: ${applicationExecutionReasonText(reason ?? "not_offered")}.`,
      { code: "gmail_digest_execution_unavailable", ...(reason && reason !== "not_offered" ? { reason } : {}) });
  }
  const revisedPart: GmailDigestProposalPayload = { ...part, agent_id: selection.agent_id, runtime_binding: binding };
  const summaries = await cardSummaries(db, card, revisedPart);
  const payload = card.kind === "digest"
    ? revisedPart
    : { ...card.payload, parts: card.payload.parts.map((entry) => entry.kind === "application" ? { ...revisedPart, card_summary: summaries.part } : entry) };
  const { revisePendingPayload } = await import("../../proposals/payloadRevision.js");
  const revisedId = await revisePendingPayload(db, transitions, actor.space_id, card.row.id, payload as Record<string, unknown>);
  if (revisedId !== card.row.id) throw new OperationError("operation_conflict", 409);
  const revision = (await db.query<{ revision: string }>(`UPDATE proposals p SET summary=$3 WHERE p.id=$1 AND p.space_id=$2 RETURNING ${proposalRevisionSql("p")} AS revision`,
    [card.row.id, actor.space_id, summaries.card])).rows[0]!.revision;
  const listed = await applicationExecutionConfigurations(db, scope, null, { selected: { runtime_profile_id: selection.runtime_profile_id, model: selection.model } });
  return {
    proposal_id: card.row.id, applies: true, scope: scopeOf(revisedPart), selected: selection,
    ...withChosen(listed, configuration, true), summary: summaries.card, card_revision: revision,
  };
}

/**
 * `source.gmail.application_updates.execution_options` (query) and `.select_execution` (command): user principal,
 * `public_api`, the owner's own private card only (anyone else: the hidden 404), while they still read the Project —
 * also when a recorded choice is replayed.
 */
export function gmailApplicationExecutionRegistrations(definitions: ReadonlyMap<string, RegisteredSystemActionDefinition>): OperationRegistration[] {
  const resolve = async (_db: Queryable, raw: unknown) => {
    const proposalId = (raw as { proposal_id: string }).proposal_id;
    return { authority: `proposal:${proposalId}`, targets: { proposal_id: proposalId }, resourceType: "proposal", resourceId: proposalId };
  };
  const ownerReads = async (db: Queryable, actor: OperationActor, proposalId: string) => {
    const card = await ownerCard(db, actor, proposalId);
    if (card.part && !await canReadProject(db, actor.space_id, card.part.project_id, actor.on_behalf_of_user_id!)) throw hidden();
  };
  return [
    {
      definition: definitions.get("source.gmail.application_updates.execution_options")!,
      readKind: "metadata",
      resolve,
      async authorize(db, raw, actor) { await ownerReads(db, actor, (raw as { proposal_id: string }).proposal_id); },
      async execute(db, raw, actor) {
        const input = raw as OperationInput<"source.gmail.application_updates.execution_options">;
        return optionsFor(db, actor, await ownerCard(db, actor, input.proposal_id), { cursor: input.cursor, models_of: input.models_of });
      },
    },
    {
      definition: definitions.get("source.gmail.application_updates.select_execution")!,
      resolve,
      async authorize(db, raw, actor) { await ownerReads(db, actor, (raw as { proposal_id: string }).proposal_id); },
      // A replayed choice names the Project's Agents and runtimes: shown only while the owner still reads the Project.
      async authorizeResult(db, raw, actor) { await ownerReads(db, actor, (raw as { proposal_id: string }).proposal_id); },
      async execute(db, raw, actor) { return selectExecution(db, actor, raw as OperationInput<"source.gmail.application_updates.select_execution">); },
    },
  ];
}
