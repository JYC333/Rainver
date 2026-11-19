import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {loadConfig} from '../src/config.js';
import type {Pool} from '../src/db/pool.js';
import {OperationExecutor} from '../src/modules/systemActions/operations/executor.js';
import type {OperationRegistration} from '../src/modules/systemActions/operations/types.js';

/**
 * Which transaction owner a core registration may declare, and which
 * combinations the executor refuses at composition. Exactly one owner (or none)
 * per registration; the closed business lists for placement and privileged
 * admission are not something a registration (or plugin) can claim.
 */
const config = loadConfig({});
type Def = OperationRegistration['definition'];
const definition = (id: string, extra: Partial<Def> = {}): Def => ({
  id, version: 1, title: id, description: id, execution: {kind: 'command', tx: 'core_owned'}, input_schema: z.object({}), output_schema: z.object({}),
  side_effects: 'durable', idempotency_required: true, policy_action: id, owning_module: 'test', application_service: 'Test', proposal_type: null, gate_class: null,
  grantable: false, visibility: new Set(['public_api']), allowed_actor_types: ['user'], agent_tool_surface: 'generic', policy_adapter: 'declared_resource',
  ...extra,
} as unknown as Def);
const base = (id: string, extra: Partial<Def> = {}): OperationRegistration => ({
  definition: definition(id, extra),
  resolve: async () => ({authority: id, targets: {}, resourceType: 'test', resourceId: null}),
  authorize: async () => {},
  execute: async () => ({}),
});
const approval = {proposalType: 'memory_create', gate: {kind: 'unattended_origin' as const, policy_rule_id: 'unattended_project_write_require_approval' as const}, mode: 'proposal_submission' as const,
  atomicStatusWritersVerified: true as const, create: async () => 'p', preconditions: async () => null};
const owners = {
  approval: {approval},
  placement: {userContentCreation: true as const},
  decision: {proposalDecisionOwner: {roots: async () => []}},
  terminal: {runTerminalOwner: {discover: async () => []}},
  admission: {admission: {kind: 'person' as const}, domainAuthorizationFirst: true as const, authorizeResult: async () => {}},
};
const compose = (...items: OperationRegistration[]) => new OperationExecutor({} as Pool, config, items);

describe('operation registration owners', () => {
  it('admits one owner per registration, each under its own rules', () => {
    expect(() => compose(
      base('direct.command'),
      {...base('direct.query', {execution: {kind: 'query', tx: 'core_owned'}, side_effects: 'none', idempotency_required: false} as Partial<Def>), readKind: 'metadata'},
      {...base('approval.command'), ...owners.approval},
      {...base('board.create'), ...owners.placement},
      {...base('task.create', {allowed_actor_types: ['user', 'agent'], visibility: new Set(['public_api', 'agent_tool'])} as Partial<Def>), ...owners.placement},
      {...base('decision.command'), ...owners.decision},
      {...base('terminal.command'), ...owners.terminal},
      {...base('personal_memory_grant.create'), ...owners.admission},
      {...base('domain.first'), domainAuthorizationFirst: true},
      {...base('decision.domain_first'), ...owners.decision, domainAuthorizationFirst: true},
    )).not.toThrow();
  });

  it('refuses any two owners together', () => {
    const keys = Object.keys(owners) as (keyof typeof owners)[];
    for (const [i, a] of keys.entries()) for (const b of keys.slice(i + 1)) {
      // A valid id for whichever owner is present, so only the combination is wrong.
      const id = a === 'admission' || b === 'admission' ? 'personal_memory_grant.create' : a === 'placement' || b === 'placement' ? 'board.create' : 'combined.command';
      expect(() => compose({...base(id), ...owners[a], ...owners[b]}), `${a}+${b}`).toThrow();
    }
  });

  it('keeps privileged admission and placement to their closed business lists', () => {
    // A plugin (or any unlisted command) cannot claim person admission or human placement.
    expect(() => compose({...base('plugin.probe.record.write'), ...owners.admission})).toThrow('Invalid person admission registration');
    expect(() => compose({...base('plugin.probe.record.write'), admission: {kind: 'daemon_workspace'}, domainAuthorizationFirst: true, authorizeResult: async () => {}})).toThrow('Invalid person admission registration');
    expect(() => compose({...base('plugin.probe.record.write'), ...owners.placement})).toThrow('Human content placement requires an explicitly admitted user-only creation command');
    // Admission keeps its reviewed shape: domain-first authorization and result authorization.
    expect(() => compose({...base('personal_memory_grant.create'), admission: {kind: 'person'}, authorizeResult: async () => {}})).toThrow('Invalid person admission registration');
    expect(() => compose({...base('personal_memory_grant.create', {allowed_actor_types: ['user', 'agent']} as Partial<Def>), ...owners.admission})).toThrow('Invalid person admission registration');
  });

  it('refuses owners on a query, unverified approval, a query with effects and a duplicate id', () => {
    const query = {execution: {kind: 'query', tx: 'core_owned'}, side_effects: 'none', idempotency_required: false} as Partial<Def>;
    for (const owner of ['approval', 'decision', 'terminal'] as const) expect(() => compose({...base('q', query), readKind: 'metadata', ...owners[owner]}), owner).toThrow();
    expect(() => compose({...base('a'), approval: {...approval, atomicStatusWritersVerified: false as unknown as true}})).toThrow('Approval mapping has not passed canonical transition enablement');
    expect(() => compose({...base('q', {...query, side_effects: 'durable'} as Partial<Def>), readKind: 'metadata'})).toThrow('Invalid migrated operation registration');
    expect(() => compose(base('same'), base('same'))).toThrow('Invalid migrated operation registration');
  });

  it('refuses domain-first authorization beside approval or Run terminal preparation at composition', () => {
    expect(() => compose({...base('a'), ...owners.approval, domainAuthorizationFirst: true})).toThrow();
    expect(() => compose({...base('t'), ...owners.terminal, domainAuthorizationFirst: true})).toThrow();
  });
});
