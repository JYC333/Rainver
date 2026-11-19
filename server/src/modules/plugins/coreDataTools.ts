import {createHash} from 'node:crypto';
import type {PluginOperationManifest, PluginToolPin} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {gmailAgentReadAvailable} from '../sources/gmail/gmailAgentReadAvailability.js';
import {GMAIL_AGENT_READ_PURPOSE, gmailAgentReadConsentTarget, liveGmailAgentReadConsents, lockGmailConsentConnection} from '../sources/gmail/gmailAgentReadGrants.js';
import {GMAIL_DIGEST_CONSENT_ID, gmailDigestReadAvailable, liveGmailDigestConsents} from '../sources/gmail/gmailDigests.js';
import {HttpError} from '../routeUtils/common.js';

/**
 * Core Agent tools that reach personal or sensitive data (ADR 0032). They are
 * not plugin operations, but they take ADR 0030's path: the frozen snapshot
 * pin, the scenario table, the data owner's consent row in
 * `plugin_data_grants`, the release gate, Run taint and the Agent-read log.
 * A **Project-bound** tool (`projectBound`, ADR 0033 §6)
 * differs from a sensitive plugin tool in two rules only: it runs
 * on the conversation's own selected runtime (CLI, Host, native login and
 * model — no isolated launch or model-only channel is required), and its
 * result may reach a shared audience, but only one whose every reader still
 * reads the Project its consent is bound to (`audienceWithinProject`); the
 * credential stays on the server and the read goes through its broker. Each has a reserved consent
 * id that no plugin can take (plugin ids are `[a-z][a-z0-9_]*`, so a `:` never
 * matches), and an availability rule its owning module states: a tool that is
 * not available is absent from the snapshot and refused at call time.
 *
 * Their one consent is the data owner's standing, read-only `project` consent
 * (ADR 0033), bound to a Project, one of the owner's connections at its
 * current generation and a purpose, and found by the owning module
 * (`consents`). No per-Run, background or Space-wide consent exists for them,
 * and no write tool is declared. Each tool serves exactly one scenario
 * (`origin`): an on-demand read only the owner's own turn (`manual`), a
 * digest read only its scheduled Run (`scheduled`, ADR 0033 phase B), whose
 * consent is given on the owner's confirmation card, never requested.
 */
export interface CoreDataTool {
  /** `plugin_data_grants.plugin_id` and the taint's `plugin_id`. */
  consentId: string;
  name: string;
  pin: PluginToolPin;
  /** The one ADR 0030 scenario whose Runs this tool's consent admits. */
  origin: 'manual' | 'scheduled';
  /**
   * Bound to the consent's Project instead of to an isolated launch and an owner-only audience: no isolation
   * proof is required, and a shared audience is admitted only while every reader reads that Project.
   */
  projectBound: true;
  /** Whether the person may be offered the tool in this conversation now (snapshot and call time). */
  available(db: Queryable, input: {spaceId: string; userId: string; sessionId: string | null; runId?: string | null}): Promise<boolean>;
  /** The owner's live consents that admit this Run (optionally one bound resource), oldest first. */
  consents(db: Queryable, input: {spaceId: string; ownerUserId: string; runId: string; bindingId?: string | null; lock?: boolean}): Promise<{id: string; expanded_json: unknown}[]>;
  /**
   * What a new consent given from this Run's conversation binds (Project, bound resource and its generation,
   * purpose); refuses when the conversation or resource cannot carry one.
   */
  consentTarget(db: Queryable, input: {spaceId: string; ownerUserId: string; runId: string; bindingId: string | null; lock?: boolean}): Promise<{projectId: string; bindingId: string; generation: number; purpose: string}>;
  /**
   * Takes the bound resource's row `FOR SHARE`, whatever its state, and decides nothing: an approval takes it
   * after the Run and before the request row, the order the resource's closing writers keep (resource
   * `FOR UPDATE` → request), so the two never wait on each other in a cycle.
   */
  lockBinding(db: Queryable, input: {spaceId: string; ownerUserId: string; bindingId: string}): Promise<void>;
}

const TOOLS: readonly CoreDataTool[] = Object.freeze([{
  consentId: 'core:gmail',
  name: 'Gmail',
  pin: {action_id: 'source.gmail.mail.read', action_version: 1, data_class: 'sensitive', side_effects: 'none', gate_class: null},
  origin: 'manual',
  projectBound: true,
  available: gmailAgentReadAvailable,
  consentTarget: async (db, input) => {
    const target = await gmailAgentReadConsentTarget(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, runId: input.runId, connectionId: input.bindingId, lock: input.lock});
    return {projectId: target.projectId, bindingId: target.connectionId, generation: target.generation, purpose: GMAIL_AGENT_READ_PURPOSE};
  },
  lockBinding: (db, input) => lockGmailConsentConnection(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, connectionId: input.bindingId}),
  consents: (db, input) => liveGmailAgentReadConsents(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, runId: input.runId, connectionId: input.bindingId, lock: input.lock}),
}, {
  consentId: GMAIL_DIGEST_CONSENT_ID,
  name: 'Gmail digest',
  pin: {action_id: 'source.gmail.digest.read', action_version: 1, data_class: 'sensitive', side_effects: 'none', gate_class: null},
  origin: 'scheduled',
  projectBound: true,
  available: gmailDigestReadAvailable,
  // Given only on the owner's digest confirmation card (`gmail_digest_create`); never requested from a Run.
  consentTarget: async () => { throw new HttpError(409, 'A digest is confirmed on its own card in the conversation it delivers to'); },
  lockBinding: (db, input) => lockGmailConsentConnection(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, connectionId: input.bindingId}),
  consents: (db, input) => liveGmailDigestConsents(db, {spaceId: input.spaceId, ownerUserId: input.ownerUserId, runId: input.runId, lock: input.lock}),
}]);

/** Every core data tool, for a caller asking whether any is offered in a conversation. */
export function coreDataTools(): readonly CoreDataTool[] {
  return TOOLS;
}

export function coreDataTool(actionId: string): CoreDataTool | undefined {
  return TOOLS.find(tool => tool.pin.action_id === actionId);
}

export function coreDataToolByConsentId(consentId: string): CoreDataTool | undefined {
  return TOOLS.find(tool => tool.consentId === consentId);
}

/** Consent ids of the Project-bound core tools: their reads stay in the Project and require no isolated launch. */
export function projectBoundConsentIds(): string[] {
  return TOOLS.filter(tool => tool.projectBound).map(tool => tool.consentId);
}

/** Whether a frozen pin is a Project-bound core tool's (not a plugin's sensitive tool). */
export function projectBoundPin(actionId: string, pin: unknown): boolean {
  const tool = coreDataTool(actionId);
  return !!tool?.projectBound && !!pin && typeof pin === 'object' && (pin as {data_class?: unknown}).data_class === tool.pin.data_class;
}

/** The pin a consent freezes, as the one-operation "manifest" ADR 0030's expansion reads. */
export function coreDataToolManifest(tool: CoreDataTool): PluginOperationManifest {
  return {
    id: tool.consentId, version: String(tool.pin.action_version), name: tool.name,
    operations: [{id: tool.pin.action_id, version: tool.pin.action_version, kind: 'query', data_class: tool.pin.data_class, side_effects: tool.pin.side_effects, gate_class: tool.pin.gate_class}],
  } as unknown as PluginOperationManifest;
}

/** Contract identity of a core tool: changes exactly when its pin changes, so a changed tool needs re-consent. */
export function coreDataToolIdentity(tool: CoreDataTool): string {
  return createHash('sha256').update(JSON.stringify(tool.pin)).digest('hex');
}
