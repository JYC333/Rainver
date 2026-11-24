import type {
  Board,
  Page,
  PlanDetail,
  PromptAssetDetail,
  PromptAssetScopeType,
  PromptAssetSummary,
  PromptDeploymentRef,
  PromptEvaluationRequest,
  PromptPromotionRequestInput,
  PromptPromotionResult,
  PromptRenderPreviewRequest,
  PromptRenderPreviewResult,
  PromptRollbackRequest,
  PromptType,
  PromptVersion,
  PromptVersionCreateRequest,
  Task,
  TaskArtifact,
  TaskProposal,
  TaskRunCreateBody,
  TaskRunListItem,
  TaskWorkView,
} from '../types/api'
import { callOperation, commandReceipt, found, operationAt, queryAt } from './operations'
import { get } from './transport'
import type { OperationInput, OperationOutput, TaskInquiryThreadsPage, TaskWorkHistoryPage } from '@rainver/protocol'

// ── Prompt Registry ──────────────────────────────────────────────────────
export const promptsApi = {
  listAssets: (params: { prompt_type?: PromptType | '' } = {}) => {
    const q: Record<string, string> = {}
    if (params.prompt_type) q.prompt_type = params.prompt_type
    const query = new URLSearchParams(q).toString()
    return get<PromptAssetSummary[]>(query ? `/prompts/assets?${query}` : '/prompts/assets')
  },
  getAsset: (assetKey: string) =>
    get<PromptAssetDetail>(`/prompts/assets/${encodeURIComponent(assetKey)}`),
  listVersions: (assetKey: string) =>
    get<PromptVersion[]>(`/prompts/assets/${encodeURIComponent(assetKey)}/versions`),
  /** Keyed command; the version is read back through the versions reader. */
  createVersion: async (assetKey: string, body: PromptVersionCreateRequest, key: string = crypto.randomUUID()): Promise<PromptVersion> => {
    const receipt = await commandReceipt('prompt.version.create', { ...body, asset_key: assetKey } as OperationInput<'prompt.version.create'>, key)
    return found(await promptsApi.listVersions(receipt.asset_key), receipt.version_id, 'Prompt version')
  },
  /** Read-only query on the retained URL: no key, nothing written. */
  renderPreview: (assetKey: string, body: PromptRenderPreviewRequest): Promise<PromptRenderPreviewResult> =>
    queryAt<PromptRenderPreviewResult>(`/prompts/assets/${encodeURIComponent(assetKey)}/render-preview`, body),
  /** Keyed command; the receipt names the recorded evaluation run. */
  evaluate: (assetKey: string, body: PromptEvaluationRequest, key: string = crypto.randomUUID()) =>
    commandReceipt('prompt.evaluation.record', { ...body, asset_key: assetKey } as OperationInput<'prompt.evaluation.record'>, key),
  /** Keyed command filing the production promotion Proposal; review stays in Proposals. */
  promote: async (assetKey: string, body: PromptPromotionRequestInput, key: string = crypto.randomUUID()): Promise<PromptPromotionResult> => {
    const { space_id: _space, ...receipt } = await commandReceipt('prompt.promotion.propose', { ...body, asset_key: assetKey } as OperationInput<'prompt.promotion.propose'>, key)
    return receipt
  },
  listDeployments: (assetKey: string, params: { include_history?: boolean } = {}) => {
    const q: Record<string, string> = {}
    if (params.include_history !== undefined) q.include_history = String(params.include_history)
    const query = new URLSearchParams(q).toString()
    return get<PromptDeploymentRef[]>(`/prompts/assets/${encodeURIComponent(assetKey)}/deployments${query ? `?${query}` : ''}`)
  },
  /** Keyed command; the ref is read back through the deployments reader. */
  setDeployment: async (assetKey: string, label: string, body: { version_id: string; scope_type?: PromptAssetScopeType; scope_id?: string | null; promoted_from_proposal_id?: string | null }, key: string = crypto.randomUUID()): Promise<PromptDeploymentRef> => {
    const receipt = await commandReceipt('prompt.deployment.set', { ...body, asset_key: assetKey, label }, key)
    return found(await promptsApi.listDeployments(receipt.asset_key), receipt.deployment_id, 'Prompt deployment')
  },
  rollback: async (assetKey: string, body: PromptRollbackRequest, key: string = crypto.randomUUID()): Promise<PromptDeploymentRef> => {
    const receipt = await commandReceipt('prompt.deployment.rollback', { ...body, asset_key: assetKey } as OperationInput<'prompt.deployment.rollback'>, key)
    return found(await promptsApi.listDeployments(receipt.asset_key), receipt.deployment_id, 'Prompt deployment')
  },
}

// ── Boards (task surfaces) ────────────────────────────────────────────────
export const boardsApi = {
  list:   (params: Record<string, string> = {}, options: { spaceId?: string } = {}) =>
    get<Page<Board>>('/boards?' + new URLSearchParams(params), { spaceId: options.spaceId }),
  // Explicit-key core commands; the Board is read back through its GET.
  create: async (body: OperationInput<'board.create'>, key: string = crypto.randomUUID()) => {
    const receipt = await operationAt<OperationOutput<'board.create'>>('POST', '/boards', body, key)
    return get<Board>(`/boards/${encodeURIComponent(receipt.board_id)}`)
  },
  get:    (id: string) => get<Board>(`/boards/${id}`),
  update: (id: string, body: Omit<OperationInput<'board.update'>, 'board_id'>, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'board.update'>>('PATCH', `/boards/${encodeURIComponent(id)}`, body, key),
  tasks:  (boardId: string, params: Record<string, string> = {}) =>
    get<Page<Task>>(`/boards/${boardId}/tasks?` + new URLSearchParams(params)),
}

// ── Tasks (product work items) ─────────────────────────────────────────────
export const tasksApi = {
  moveToColumn: (id:string, body:Omit<OperationInput<'task.move_to_column'>,'task_id'>, key:string) =>
    callOperation('task.move_to_column',{...body,task_id:id},key),
  delete: (id:string, key:string) => callOperation('task.delete',{task_id:id},key),
  setStatus: (id:string, body:Omit<OperationInput<'task.set_status'>,'task_id'>, key:string) =>
    callOperation('task.set_status',{...body,task_id:id},key),
  linkedThreads:(id:string,after?:string)=>get<TaskInquiryThreadsPage>(`/tasks/${encodeURIComponent(id)}/inquiry-threads${after?`?after_thread_id=${encodeURIComponent(after)}`:''}`),
  workHistory:(id:string,before?:string)=>get<TaskWorkHistoryPage>(`/tasks/${encodeURIComponent(id)}/work-history${before?`?before_seq=${encodeURIComponent(before)}`:''}`),
  work:  (id: string) => get<TaskWorkView>(`/tasks/${id}/work`),
  list:   (params: Record<string, string> = {}) =>
    get<Page<Task>>('/tasks?' + new URLSearchParams(params)),
  // One explicit key per person's create; never retried automatically.
  create: (data: OperationInput<'task.create'>, options: { spaceId?: string } = {}, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'task.create'>>('POST', '/tasks', data, key, { spaceId: options.spaceId }),
  get:    (id: string) => get<Task>(`/tasks/${id}`),
  update: async (id: string, data: Record<string, unknown>, key?:string) => {
    if(Object.prototype.hasOwnProperty.call(data,'board_id')||Object.prototype.hasOwnProperty.call(data,'column_id')){
      // Placement and the accompanying contract edits commit together.
      await callOperation('task.place_in_space_board',{task_id:id,changes:data as OperationInput<'task.place_in_space_board'>['changes']},key??crypto.randomUUID());
      return get<Task>(`/tasks/${id}`);
    }
    await operationAt<OperationOutput<'task.update'>>('PATCH', `/tasks/${encodeURIComponent(id)}`, data, key??crypto.randomUUID())
    return get<Task>(`/tasks/${id}`)
  },
  createRun: (taskId: string, body: TaskRunCreateBody = {}, key: string = crypto.randomUUID()) =>
    // One Run, whichever branch admits it: the remote path creates its Run
    // synchronously, exactly as the server path does.
    operationAt<OperationOutput<'task.run.create'>>('POST', `/tasks/${encodeURIComponent(taskId)}/runs`, body, key),
  runs:   (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskRunListItem>>(`/tasks/${taskId}/runs?` + new URLSearchParams(params)),
  artifacts: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskArtifact>>(`/tasks/${taskId}/artifacts?` + new URLSearchParams(params)),
  proposals: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskProposal>>(`/tasks/${taskId}/proposals?` + new URLSearchParams(params)),
  requestPlan: (taskId: string, body: Omit<OperationInput<'task.plan.request'>, 'task_id'> = {}, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'task.plan.request'>>('POST', `/tasks/${encodeURIComponent(taskId)}/plan-requests`, body, key),
  plan: (taskId: string) => get<PlanDetail | null>(`/tasks/${encodeURIComponent(taskId)}/plan`),
}
