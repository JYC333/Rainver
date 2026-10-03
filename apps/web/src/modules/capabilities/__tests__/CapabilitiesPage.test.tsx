import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CapabilitiesPage from '../CapabilitiesPage'
import { capabilitiesFrameworkApi } from '../../../api/client'
import type { SkillImportPreviewResponse } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../api/client', () => ({
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
})
