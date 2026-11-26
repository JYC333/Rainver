import {DAEMON_WORKSPACE_OPERATIONS} from '../../hosts/workspaceActor.js';
import {PERSON_OPERATIONS} from './personAdmission.js';
import type {OperationRegistration} from './types.js';

/** Durable new-content commands whose Personal/Project placement the access owner chooses
 * exactly as their retained REST adapters always did. Never an arbitrary Space resolver. */
const DURABLE_PLACEMENT_COMMANDS = new Set(['activity.upload','activity.create','capture.create','source.channel.create', 'source.item.save_url', 'source.evidence.create', 'source.custom.draft.create', 'source.goal.setup.begin', 'source.goal.create', 'agent.create', 'agent.role.instantiate', 'agent.run.create', 'agent.chat.send', 'session.create', 'board.create', 'task.create']);
/** One create shared by a person's REST call and an Agent Run tool: placement applies to the person
 * principal only; an Agent keeps its Run's Space and Project. */
const PERSON_PLACEMENT_SHARED_COMMANDS = new Set(['task.create', 'knowledge.note.create']);
// Proposal submission retains the access-owned placement of the old REST create
// entry, without enabling an approval execution mapping. No other proposal may
// resolve a caller into another Space.
const PROPOSAL_PLACEMENT_COMMANDS = new Map<string,{proposalType:string;gateClass:string}>([['knowledge.item.propose_create',{proposalType:'knowledge_create',gateClass:'exposure'}],['knowledge.claim.propose_create',{proposalType:'claim_create',gateClass:'exposure'}],['memory.propose_create',{proposalType:'memory_create',gateClass:'belief_reach'}]]);

/**
 * The one transaction owner a registration declares beyond the executor's
 * direct path. Owners are mutually exclusive: each changes who prepares or
 * finishes the core transaction, and two would contend for it.
 */
export type RegistrationOwner = 'direct' | 'approval' | 'user_placement' | 'proposal_decision' | 'run_terminal' | 'person_admission' | 'daemon_admission';

function owner(item: OperationRegistration): RegistrationOwner {
  const declared: RegistrationOwner[] = [];
  if (item.approval) declared.push('approval');
  if (item.userContentCreation) declared.push('user_placement');
  if (item.proposalDecisionOwner) declared.push('proposal_decision');
  if (item.runTerminalOwner) declared.push('run_terminal');
  if (item.admission) declared.push(item.admission.kind === 'person' ? 'person_admission' : 'daemon_admission');
  if (declared.length > 1) throw new Error(`Operation registration declares exclusive transaction owners: ${declared.join(', ')}`);
  return declared[0] ?? 'direct';
}

/**
 * Composition-time validation of one core registration (pure). Execution shape
 * first, then the rules of its single owner. Placement and privileged admission
 * stay closed business lists that no registration or plugin can claim.
 */
export function validateRegistration(item: OperationRegistration): RegistrationOwner {
  const d = item.definition;
  const query = d.execution?.kind === 'query', command = d.execution?.kind === 'command';
  if (!d.execution || d.execution.tx !== 'core_owned'
    || query && (d.side_effects !== 'none' || d.idempotency_required || d.gate_class !== null || d.proposal_type !== null || !item.readKind || item.readKind === 'content' && !item.readAudit && !item.releaseGate || !!item.afterCommit)
    || item.approval?.gate.kind === 'hard_gate' && item.approval.gate.gate_class !== d.gate_class) throw new Error('Invalid migrated operation registration');
  const kind = owner(item);
  if (item.domainAuthorizationFirst && (kind === 'approval' || kind === 'user_placement' || kind === 'run_terminal')) throw new Error('Domain-first authorization cannot own approval, placement or Run terminal preparation');
  switch (kind) {
    case 'approval': {
      const a = item.approval!;
      if (!command || a.atomicStatusWritersVerified !== true || !a.proposalType || a.mode === 'blocked_command' && !a.gate.policy_rule_id) throw new Error('Approval mapping has not passed canonical transition enablement');
      break;
    }
    case 'user_placement': {
      const placement = PROPOSAL_PLACEMENT_COMMANDS.get(d.id);
      const proposalPlacement = d.side_effects === 'proposal' && !!placement && d.gate_class === placement.gateClass && d.proposal_type === placement.proposalType;
      const directPlacement = d.gate_class === null && d.proposal_type === null && (d.side_effects === 'draft' || DURABLE_PLACEMENT_COMMANDS.has(d.id) && d.side_effects === 'durable');
      const shared = PERSON_PLACEMENT_SHARED_COMMANDS.has(d.id) && d.allowed_actor_types.length === 2 && d.allowed_actor_types.includes('user') && d.allowed_actor_types.includes('agent') && [...d.visibility].every(surface => surface === 'public_api' || surface === 'agent_tool');
      const userOnly = d.allowed_actor_types.length === 1 && d.allowed_actor_types[0] === 'user' && !d.grantable && [...d.visibility].every(surface => surface === 'public_api');
      if (!command || !proposalPlacement && !directPlacement || !shared && !userOnly) throw new Error('Human content placement requires an explicitly admitted user-only creation command');
      break;
    }
    case 'proposal_decision':
      if (!command) throw new Error('Proposal decision preparation requires a direct command transaction owner');
      break;
    case 'run_terminal':
      if (!command) throw new Error('Run terminal preparation requires a direct command transaction owner');
      break;
    case 'person_admission':
    case 'daemon_admission': {
      const person = kind === 'person_admission';
      if (!(person ? PERSON_OPERATIONS : DAEMON_WORKSPACE_OPERATIONS).has(d.id) || !command || d.allowed_actor_types.length !== 1 || d.allowed_actor_types[0] !== (person ? 'user' : 'system')
        || d.grantable || [...d.visibility].some(surface => surface !== 'public_api') || !item.domainAuthorizationFirst || !item.authorizeResult) throw new Error('Invalid person admission registration');
      break;
    }
    case 'direct':
      break;
  }
  return kind;
}
