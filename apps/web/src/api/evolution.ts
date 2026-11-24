import type {
  EvolutionBundle,
  EvolutionExperience,
  EvolutionProposal,
  EvolutionRunListItem,
  EvolutionRunResult,
  EvolutionSelectorDecision,
  EvolutionSignal,
  EvolutionSignalCreateBody,
  EvolutionStrategy,
  EvolutionSummaryOut,
  EvolutionTarget,
  EvolutionTargetCreateBody,
  EvolutionTargetUpdateBody,
  EvolutionValidationResult,
  EvolvableAsset,
  EvolvableAssetEvaluationCase,
  EvolvableAssetEvaluationRun,
  EvolvableAssetPin,
  EvolvableAssetVersion,
  ResolvedEvolvableAssetVersion,
} from '../types/api'
import { commandReceipt, found, operationAt, queryAt } from './operations'
import type { RequestOptions } from './transport'
import { get } from './transport'
import type { OperationInput, OperationOutput } from '@rainver/protocol'

// ── Evolution ─────────────────────────────────────────────────────────────
/** A Run start the selector declined: its decision is recorded, no Run or Job exists. */
export class EvolutionRunNotSelected extends Error {
  constructor(message: string, readonly selectorDecisionId: string) {
    super(message)
    this.name = 'EvolutionRunNotSelected'
  }
}

export const evolutionApi = {
  summary: () => get<EvolutionSummaryOut>('/evolution/summary'),
  targets: (params: { status?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    const query = new URLSearchParams(q).toString()
    return get<EvolutionTarget[]>(query ? `/evolution/targets?${query}` : '/evolution/targets')
  },
  /** Keyed command; the target is read back through its authorized reader. */
  createTarget: async (body: EvolutionTargetCreateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionTarget> => {
    const receipt = await commandReceipt('evolution.target.create', body as OperationInput<'evolution.target.create'>, idempotencyKey)
    return get<EvolutionTarget>(`/evolution/targets/${encodeURIComponent(receipt.target_id)}`, { spaceId: receipt.space_id })
  },
  target: (id: string) => get<EvolutionTarget>(`/evolution/targets/${id}`),
  updateTarget: async (id: string, body: EvolutionTargetUpdateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionTarget> => {
    const receipt = await commandReceipt('evolution.target.update', { ...body, target_id: id } as OperationInput<'evolution.target.update'>, idempotencyKey)
    return get<EvolutionTarget>(`/evolution/targets/${encodeURIComponent(receipt.target_id)}`, { spaceId: receipt.space_id })
  },
  signals: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSignal[]>('/evolution/signals?' + new URLSearchParams(q))
  },
  targetSignals: (targetId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSignal[]>(`/evolution/targets/${targetId}/signals?` + new URLSearchParams(q))
  },
  signal: (signalId: string, options?: RequestOptions) => get<EvolutionSignal>(`/evolution/signals/${encodeURIComponent(signalId)}`, options),
  /** Keyed triage; the signal is read back through its authorized reader. */
  updateSignal: async (signalId: string, body: { triage_status: 'new' | 'acknowledged' | 'dismissed' | 'actioned'; triage_note?: string | null }, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> => {
    const receipt = await commandReceipt('evolution.signal.triage', { ...body, signal_id: signalId }, idempotencyKey)
    return evolutionApi.signal(receipt.signal_id, { spaceId: receipt.space_id })
  },
  dismissSignal: (signalId: string, body: { triage_note?: string | null } = {}, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> =>
    evolutionApi.updateSignal(signalId, { ...body, triage_status: 'dismissed' }, idempotencyKey),
  createSignal: async (targetId: string, body: EvolutionSignalCreateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> => {
    const receipt = await commandReceipt('evolution.signal.create', { ...body, target_id: targetId } as OperationInput<'evolution.signal.create'>, idempotencyKey)
    return evolutionApi.signal(receipt.signal_id, { spaceId: receipt.space_id })
  },
  runs: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionRunListItem[]>('/evolution/runs?' + new URLSearchParams(q))
  },
  /** Keyed command queuing the dry-run Evolution Run with its Job; it executes in the background. */
  runTarget: async (targetId: string, body: Omit<OperationInput<'evolution.target.run'>, 'target_id'>, key: string = crypto.randomUUID()): Promise<EvolutionRunResult> => {
    const receipt = await commandReceipt('evolution.target.run', { ...body, target_id: targetId }, key)
    if (receipt.status === 'not_selected') throw new EvolutionRunNotSelected(receipt.reason, receipt.selector_decision_id)
    return { run_id: receipt.run_id, target_id: receipt.target_id, selector_decision_id: receipt.selector_decision_id, selected_strategy_key: receipt.selected_strategy_key, run_status: 'queued', proposal_ids: [] }
  },
  strategies: (params: { status?: string; target_type?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.target_type !== undefined) q.target_type = params.target_type
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionStrategy[]>('/evolution/strategies?' + new URLSearchParams(q))
  },
  selectorDecisions: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSelectorDecision[]>('/evolution/selector-decisions?' + new URLSearchParams(q))
  },
  experiences: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionExperience[]>('/evolution/experiences?' + new URLSearchParams(q))
  },
  proposals: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionProposal[]>('/evolution/proposals?' + new URLSearchParams(q))
  },
  validation: () => get<EvolutionValidationResult[]>('/evolution/validation'),
  assets: (params: { asset_type?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.asset_type !== undefined) q.asset_type = params.asset_type
    const query = new URLSearchParams(q).toString()
    return get<EvolvableAsset[]>(query ? `/evolution/assets?${query}` : '/evolution/assets')
  },
  /** Keyed command; the asset is read back through its reader. */
  createAsset: async (body: OperationInput<'evolution.asset.create'>, key: string = crypto.randomUUID()): Promise<EvolvableAsset> => {
    const receipt = await commandReceipt('evolution.asset.create', body, key)
    return get<EvolvableAsset>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}`, { spaceId: receipt.space_id })
  },
  asset: (assetId: string) =>
    get<EvolvableAsset>(`/evolution/assets/${encodeURIComponent(assetId)}`),
  assetVersions: (assetId: string) =>
    get<EvolvableAssetVersion[]>(`/evolution/assets/${encodeURIComponent(assetId)}/versions`),
  createAssetVersion: async (assetId: string, body: Omit<OperationInput<'evolution.asset.version.create'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.create', { ...body, asset_id: assetId }, key)),
  /** The server's strict schema validates the status. */
  transitionAssetVersion: async (assetId: string, versionId: string, body: { status: string }, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.transition', { status: body.status as OperationInput<'evolution.asset.version.transition'>['status'], asset_id: assetId, version_id: versionId }, key)),
  assetPins: (assetId: string) =>
    get<EvolvableAssetPin[]>(`/evolution/assets/${encodeURIComponent(assetId)}/pins`),
  setAssetPin: async (assetId: string, scopeType: OperationInput<'evolution.asset.pin.set'>['scope_type'], scopeId: string, body: { version_id: string; reason?: string | null }, key: string = crypto.randomUUID()): Promise<EvolvableAssetPin> => {
    const receipt = await commandReceipt('evolution.asset.pin.set', { ...body, asset_id: assetId, scope_type: scopeType, scope_id: scopeId }, key)
    return found(await get<EvolvableAssetPin[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/pins`, { spaceId: receipt.space_id }), receipt.pin_id!, 'Asset pin')
  },
  deleteAssetPin: async (assetId: string, scopeType: OperationInput<'evolution.asset.pin.archive'>['scope_type'], scopeId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await commandReceipt('evolution.asset.pin.archive', { asset_id: assetId, scope_type: scopeType, scope_id: scopeId }, key)
    return null
  },
  /** Read-only query on the retained URL. */
  resolveAsset: (assetId: string, body: Omit<OperationInput<'evolution.asset.resolve'>, 'asset_id'> = {}) =>
    queryAt<ResolvedEvolvableAssetVersion>(`/evolution/assets/${encodeURIComponent(assetId)}/resolve`, body),
  assetEvaluationRuns: (assetId: string) =>
    get<EvolvableAssetEvaluationRun[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-runs`),
  evaluationCases: (assetId: string) =>
    get<EvolvableAssetEvaluationCase[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-cases`),
  /** Keyed commands; the case is read back through the cases reader. */
  createEvaluationCase: async (assetId: string, body: Omit<OperationInput<'evolution.asset.evaluation_case.create'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationCase> =>
    evaluationCaseOf(await commandReceipt('evolution.asset.evaluation_case.create', { ...body, asset_id: assetId }, key)),
  createEvaluationCaseFromRun: async (assetId: string, body: Omit<OperationInput<'evolution.asset.evaluation_case.create_from_run'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationCase> =>
    evaluationCaseOf(await commandReceipt('evolution.asset.evaluation_case.create_from_run', { ...body, asset_id: assetId }, key)),
  /** Queues the evaluation Job; the queued evaluation run is read back through its reader. */
  executeEvaluation: async (assetId: string, versionId: string, caseId: string, body: { candidate_run_id: string }, key: string = crypto.randomUUID()): Promise<{ evaluation_run: EvolvableAssetEvaluationRun; job_id: string; connector_mode: string }> => {
    const receipt = await commandReceipt('evolution.asset.evaluation.execute', { ...body, asset_id: assetId, version_id: versionId, case_id: caseId }, key)
    return { evaluation_run: await evaluationRunOf(receipt), job_id: receipt.job_id, connector_mode: receipt.connector_mode }
  },
  updateAssetVersion: async (assetId: string, versionId: string, body: { content_json?: Record<string, unknown>; content_ref?: string | null; content_hash?: string | null }, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.update', { ...body, asset_id: assetId, version_id: versionId }, key)),
  recordAssetEvaluation: async (assetId: string, versionId: string, body: Omit<OperationInput<'evolution.asset.evaluation.record'>, 'asset_id' | 'version_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationRun> =>
    evaluationRunOf(await commandReceipt('evolution.asset.evaluation.record', { ...body, asset_id: assetId, version_id: versionId }, key)),
  /** Keyed command filing the promotion Proposal; review and apply stay in Proposals. */
  createAssetPromotionProposal: async (assetId: string, versionId: string, body: Omit<OperationInput<'evolution.asset.promotion.propose'>, 'asset_id' | 'version_id'>, key: string = crypto.randomUUID()): Promise<{ proposal_id: string; status: string; proposal_type: string }> => {
    const { space_id: _space, ...receipt } = await commandReceipt('evolution.asset.promotion.propose', { ...body, asset_id: assetId, version_id: versionId }, key)
    return receipt
  },
  bundles: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionBundle[]>(`/evolution/bundles?${new URLSearchParams(q)}`)
  },
  /** Keyed command; the bundle is read back through its reader. Deciding it stays on the Proposal decision path. */
  createBundle: async (body: { title: string; description?: string | null; proposal_ids: string[] }, key: string = crypto.randomUUID()): Promise<EvolutionBundle> => {
    const receipt = await commandReceipt('evolution.bundle.create', body, key)
    return get<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(receipt.bundle_id)}`, { spaceId: receipt.space_id })
  },
  bundle: (id: string) => get<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(id)}`),
  decideBundle: (id: string, decisions: Array<{ proposal_id: string; decision: 'approve' | 'reject'; note?: string | null }>) =>
    operationAt<OperationOutput<'evolution.bundle.decide'>>('POST', `/evolution/bundles/${encodeURIComponent(id)}/decide`, { decisions }, crypto.randomUUID()).then(() => evolutionApi.bundle(id)),
  rollbackBundle: (id: string) => operationAt<OperationOutput<'evolution.bundle.rollback'>>('POST', `/evolution/bundles/${encodeURIComponent(id)}/rollback`, {}, crypto.randomUUID()).then(() => evolutionApi.bundle(id)),
  /** Read-only query on the retained URL. */
  previewWorkflowFromRun: (body: OperationInput<'evolution.workflow.preview'>) =>
    queryAt<Record<string, unknown>>('/evolution/workflows/from-run/preview', body),
  /** Keyed command; the receipt says whether a draft was saved or a Proposal filed. */
  saveWorkflowFromRun: async (body: OperationInput<'evolution.workflow.save'>, key: string = crypto.randomUUID()): Promise<SaveWorkflowFromRunResult> => {
    const { space_id: _space, ...receipt } = await commandReceipt('evolution.workflow.save', body, key)
    return receipt
  },
}

/** What saving a Run as a Workflow created: a Proposal to review, or a draft asset version. */
export type SaveWorkflowFromRunResult =
  | { status: 'proposal_required'; proposal_id: string; proposal_type: string; risk_level: string }
  | { status: 'draft_saved'; asset_id: string; version_id: string; version_status: 'draft'; risk_level: string }

const assetVersionOf=async(receipt:{space_id:string;asset_id:string;version_id:string})=>
  found(await get<EvolvableAssetVersion[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/versions`,{spaceId:receipt.space_id}),receipt.version_id,'Asset version')

const evaluationCaseOf=async(receipt:{space_id:string;asset_id:string;case_id:string})=>
  found(await get<EvolvableAssetEvaluationCase[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/evaluation-cases`,{spaceId:receipt.space_id}),receipt.case_id,'Evaluation case')

const evaluationRunOf=async(receipt:{space_id:string;asset_id:string;evaluation_run_id:string})=>
  found(await get<EvolvableAssetEvaluationRun[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/evaluation-runs`,{spaceId:receipt.space_id}),receipt.evaluation_run_id,'Evaluation run')
