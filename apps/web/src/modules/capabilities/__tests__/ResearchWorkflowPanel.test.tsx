import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ResearchWorkflowPanel } from '../ResearchWorkflowPanel'
import { agentsApi, capabilitiesFrameworkApi, projectWorkflowProfilesApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
  }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  artifactsApi: {
    list: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
  },
  contextApi: {
    listArtifactRevocations: vi.fn().mockResolvedValue({ items: [] }),
    revokeArtifact: vi.fn(),
    unrevokeArtifact: vi.fn(),
  },
  capabilitiesFrameworkApi: {
    listWorkflowTemplates: vi.fn().mockResolvedValue([
      {
        id: 'test.research_workflow',
        name: 'Technical Survey',
        description: 'Survey technical sources.',
        category: 'research',
        capability_ids: ['research.source_collect'],
        input_schema_json: {},
        default_config_json: {},
        output_artifact_types: ['research_report.archive.v1'],
        proposal_policy: {},
        recommended_runtime_adapters: ['model_api'],
        prompt_asset_keys: ['test.research_workflow.run'],
      },
    ]),
  },
  projectWorkflowProfilesApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: 'profile-1',
        space_id: 'space-1',
        project_id: 'project-1',
        workflow_template_id: 'test.research_workflow',
        name: 'Existing profile',
        enabled: true,
        config_json: {
          source_mode: 'project_sources',
          output_artifact_types: ['research_report.archive.v1'],
          preferred_runtime_adapter: 'model_api',
        },
        created_by_user_id: 'user-1',
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:00:00.000Z',
      },
    ]),
    create: vi.fn(),
    update: vi.fn(),
    buildTemplateRunDraft: vi.fn().mockResolvedValue({
      workflow_template: {
        id: 'test.research_workflow',
        name: 'Technical Survey',
        description: 'Survey technical sources.',
        category: 'research',
        capability_ids: ['research.source_collect'],
        input_schema_json: {},
        default_config_json: {},
        output_artifact_types: ['research_report.archive.v1'],
        proposal_policy: {},
        recommended_runtime_adapters: ['model_api'],
        prompt_asset_keys: ['test.research_workflow.run'],
      },
      workflow_profile: null,
      capability_ids: ['research.source_collect'],
      output_artifact_types: ['research_report.archive.v1'],
      config_json: {},
      run_create_body: {
        mode: 'live',
        run_type: 'agent',
        trigger_origin: 'manual',
        project_id: 'project-1',
        agent_id: null,
        prompt: 'Draft prompt',
        adapter_type: null,
        capability_id: 'research.source_collect',
        capabilities_json: ['research.source_collect'],
      },
      warnings: ['agent_required_to_execute_run_draft'],
    }),
    buildRunDraft: vi.fn().mockResolvedValue({
      workflow_template: {
        id: 'test.research_workflow',
        name: 'Technical Survey',
        description: 'Survey technical sources.',
        category: 'research',
        capability_ids: ['research.source_collect'],
        input_schema_json: {},
        default_config_json: {},
        output_artifact_types: ['research_report.archive.v1'],
        proposal_policy: {},
        recommended_runtime_adapters: ['model_api'],
        prompt_asset_keys: ['test.research_workflow.run'],
      },
      workflow_profile: {
        id: 'profile-1',
        space_id: 'space-1',
        project_id: 'project-1',
        workflow_template_id: 'test.research_workflow',
        name: 'Existing profile',
        enabled: true,
        config_json: {},
        created_by_user_id: 'user-1',
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:00:00.000Z',
      },
      capability_ids: ['research.source_collect'],
      output_artifact_types: ['research_report.archive.v1'],
      config_json: {},
      run_create_body: {
        mode: 'live',
        run_type: 'agent',
        trigger_origin: 'manual',
        project_id: 'project-1',
        agent_id: null,
        prompt: 'Draft prompt',
        adapter_type: 'model_api',
        capability_id: 'research.source_collect',
        capabilities_json: ['research.source_collect'],
      },
      warnings: ['agent_required_to_execute_run_draft'],
    }),
  },
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: 'agent-1',
        space_id: 'space-1',
        created_by_user_id: 'user-1',
        name: 'Research Agent',
        description: null,
        visibility: 'space_shared',
        role_instruction: null,
        status: 'active',
        agent_kind: 'standard',
        current_version_id: 'version-1',
        source_template_id: null,
        source_template_version_id: null,
        model: null,
        adapter_type: 'model_api',
        requires_model_provider: false,
        system_prompt: null,
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:00:00.000Z',
      },
    ]),
    listRuntimeProfiles: vi.fn().mockResolvedValue([
      {
        id: 'runtime-profile-1',
        space_id: 'space-1',
        agent_id: 'agent-1',
        name: 'Default',
        adapter_type: 'model_api',
        model: null,
        credential_profile_id: null,
        runtime_config_json: { adapter_type: 'model_api' },
        runtime_policy_json: { default_adapter_type: 'model_api' },
        enabled: true,
        is_default: true,
        created_at: '2026-06-20T00:00:00.000Z',
        updated_at: '2026-06-20T00:00:00.000Z',
      },
    ]),
    createRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  },
}))

describe('ResearchWorkflowPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('labels project source mode as linked context, not source management', async () => {
    render(<ResearchWorkflowPanel projectId="project-1" projectName="Project" />)

    await screen.findByText('No saved preset')
    expect(screen.getByText('Linked project context')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Linked project context'))
    expect(screen.getByText('Prompt URLs')).toBeInTheDocument()
  })

  it('keeps a run draft launchable when the agent is selected after building the draft', async () => {
    render(<ResearchWorkflowPanel projectId="project-1" projectName="Project" />)

    await screen.findByText('No saved preset')
    fireEvent.change(screen.getByPlaceholderText('What should this project research run answer?'), {
      target: { value: 'What should we survey?' },
    })

    fireEvent.click(screen.getByText('Build run draft'))
    await screen.findByText('Draft prompt')

    fireEvent.click(screen.getByText('Select agent…'))
    fireEvent.click(screen.getByText('Research Agent · model_api'))
    await screen.findByText('Default · model_api')

    expect(screen.getByText('Draft prompt')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Launch queued run'))

    await waitFor(() => {
      expect(agentsApi.createRun).toHaveBeenCalled()
    })
    const [agentId, runBody] = vi.mocked(agentsApi.createRun).mock.calls[0]
    expect(agentId).toBe('agent-1')
    expect(runBody).toMatchObject({
      prompt: 'Draft prompt',
      project_id: 'project-1',
      runtime_profile_id: 'runtime-profile-1',
      capabilities_json: ['research.source_collect'],
    })
    expect(runBody).not.toHaveProperty('adapter_type')
    expect(projectWorkflowProfilesApi.buildTemplateRunDraft).toHaveBeenCalled()
    expect(projectWorkflowProfilesApi.buildRunDraft).not.toHaveBeenCalled()
    expect(capabilitiesFrameworkApi.listWorkflowTemplates).toHaveBeenCalled()
  })

  it('uses saved preset output types when building a profile draft', async () => {
    render(<ResearchWorkflowPanel projectId="project-1" projectName="Project" />)

    await screen.findByText('No saved preset')
    fireEvent.click(screen.getByText('No saved preset'))
    fireEvent.click(screen.getByText('Existing profile · Technical Survey'))

    await waitFor(() => {
      expect(screen.getByDisplayValue('Existing profile')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('What should this project research run answer?'), {
      target: { value: 'What should the preset survey?' },
    })
    fireEvent.click(screen.getByText('Build run draft'))

    await waitFor(() => {
      expect(projectWorkflowProfilesApi.buildRunDraft).toHaveBeenCalled()
    })

    expect(projectWorkflowProfilesApi.buildRunDraft).toHaveBeenCalledWith(
      'project-1',
      'profile-1',
      expect.objectContaining({
        config_json: expect.objectContaining({
          output_artifact_types: ['research_report.archive.v1'],
        }),
      }),
    )
    expect(projectWorkflowProfilesApi.buildTemplateRunDraft).not.toHaveBeenCalled()
  })
})
