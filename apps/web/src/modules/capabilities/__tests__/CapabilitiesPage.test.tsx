import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CapabilitiesPage from '../CapabilitiesPage'
import i18n from '../../../i18n'
import { ApiRequestError, capabilitiesFrameworkApi } from '../../../api/client'
import type { SkillImportPreviewResponse, SkillPackage } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
  },
  capabilitiesFrameworkApi: {
    listCapabilityDefinitions: vi.fn(),
    listCapabilityPacks: vi.fn(),
    listSkillPackages: vi.fn(),
    getSkillPackage: vi.fn(),
    previewSkillImport: vi.fn(),
    importSkill: vi.fn(),
    createSkillReviewProposal: vi.fn(),
    convertSkillToCapability: vi.fn(),
  },
}))

const previewedPackage = {
  source: {},
  normalized_skill: { name: 'Previewed skill', description: 'The package that was looked at' },
  package_root: 'skills/previewed',
  package_hash: 'abc123',
  package_files: [],
  risk_level: 'low',
  requested_permissions: [],
  files_detected: [],
  warnings: [],
  persistable: true,
} as unknown as SkillImportPreviewResponse

describe('CapabilitiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(capabilitiesFrameworkApi.listCapabilityDefinitions).mockResolvedValue([])
    vi.mocked(capabilitiesFrameworkApi.listCapabilityPacks).mockResolvedValue([])
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [] } as never)
    vi.mocked(capabilitiesFrameworkApi.previewSkillImport).mockResolvedValue(previewedPackage)
  })

  it('withdraws a preview once the URL changes, so Import cannot send an unpreviewed package', async () => {
    render(<CapabilitiesPage />)
    const url = screen.getByPlaceholderText(/github\.com/)
    fireEvent.change(url, { target: { value: 'https://github.com/org/repo/tree/main/previewed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('Previewed skill')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()

    fireEvent.change(url, { target: { value: 'https://github.com/org/repo/tree/main/other' } })

    expect(screen.queryByText('Previewed skill')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('does not announce a refresh that failed', async () => {
    render(<CapabilitiesPage />)
    await waitFor(() => expect(capabilitiesFrameworkApi.listSkillPackages).toHaveBeenCalled())
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockRejectedValueOnce(new Error('503 Service Unavailable'))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('503 Service Unavailable'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('imports with the previewed package hash, and asks for a new preview when the package changed', async () => {
    vi.mocked(capabilitiesFrameworkApi.importSkill).mockRejectedValueOnce(
      new (ApiRequestError as unknown as new (m: string, s: number, c?: string) => Error)('changed', 409, 'skill_package_changed'),
    )
    render(<CapabilitiesPage />)
    const url = screen.getByPlaceholderText(/github\.com/)
    fireEvent.change(url, { target: { value: 'https://github.com/org/repo/tree/main/previewed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('Previewed skill')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({
      url: 'https://github.com/org/repo/tree/main/previewed',
      package_hash: 'abc123',
    }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This package changed since you previewed it. Preview it again before importing.'))
    expect(screen.queryByText('Previewed skill')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('shows a pending review and does not offer Review again while the proposal waits', async () => {
    const skill = {
      id: 'package-1', source_id: 'source-1', package_name: 'Example skill', version: null, license: null,
      raw_storage_ref: null, manifest_json: {}, normalized_json: {}, risk_level: 'low', status: 'imported',
      created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z',
      pending_proposal: { id: 'proposal-1', operation: 'skill_import_approve' },
    } as unknown as SkillPackage
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [skill] } as never)
    vi.mocked(capabilitiesFrameworkApi.getSkillPackage).mockResolvedValue(skill)
    render(<CapabilitiesPage />)

    const pending = await screen.findByRole('button', { name: /Review pending/ })
    expect(pending).toBeDisabled()
    expect(screen.getByText('Your proposal is waiting for review in Proposals.')).toBeInTheDocument()
    expect(capabilitiesFrameworkApi.createSkillReviewProposal).not.toHaveBeenCalled()
  })

  it('reads in Chinese, counting previewed files in the Chinese plural', async () => {
    await i18n.changeLanguage('zh-CN')
    try {
      vi.mocked(capabilitiesFrameworkApi.previewSkillImport).mockResolvedValue({
        ...previewedPackage,
        package_files: [{ path: 'SKILL.md', kind: 'markdown', executable: false }, { path: 'run.sh', kind: 'script', executable: true }],
      } as unknown as SkillImportPreviewResponse)
      render(<CapabilitiesPage />)
      expect(screen.getByRole('heading', { name: '能力' })).toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText(/github\.com/), { target: { value: 'https://github.com/org/repo/tree/main/previewed' } })
      fireEvent.click(screen.getByRole('button', { name: '预览' }))
      expect(await screen.findByText('2 个文件')).toBeInTheDocument()
      expect(screen.getByText('1 个脚本')).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })
})
