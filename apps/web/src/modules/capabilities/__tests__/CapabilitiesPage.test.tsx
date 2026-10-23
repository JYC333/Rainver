import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SkillsPage from '../SkillsPage'
import i18n from '../../../i18n'
import { ApiRequestError, capabilitiesFrameworkApi, hostsApi, proposalsApi } from '../../../api/client'
import type { SkillImportPreviewResponse, SkillPackage } from '@rainver/protocol'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const space = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', userId: 'user-1', spaces: [{ id: 'space-1', role: space.role }] }) }))
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { id: 'user-1', is_instance_admin: false } }) }))
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error { constructor(message: string, readonly status: number, readonly code?: string, readonly payload?: Record<string, unknown>) { super(message) } },
  projectsApi: { list: vi.fn().mockResolvedValue({ items: [] }) }, agentsApi: { list: vi.fn().mockResolvedValue([]) },
  hostsApi: { list: vi.fn() }, proposalsApi: { accept: vi.fn(), reject: vi.fn() },
  capabilitiesFrameworkApi: { listSkillPackages: vi.fn(), getSkillPackage: vi.fn(), getSkillContent: vi.fn(), listSkillBindings: vi.fn(),
    previewSkillImport: vi.fn(), importSkill: vi.fn(), createSkillReviewProposal: vi.fn(), createSkillBindingProposal: vi.fn(), scanHostSkills: vi.fn() },
}))
const skill = { id: 'a'.repeat(64), name: 'Review code', runtime_key: 'claude_code', installation: 'own', display_path: '~/.claude/skills/review' } as const
const preview = { source: {}, normalized_skill: { name: 'Previewed skill', description: 'Original package' }, package_root: '.', package_hash: 'b'.repeat(64), package_files: [], risk_level: 'low', warnings: [], persistable: true } as unknown as SkillImportPreviewResponse
const pkg = { id: 'package-1', package_name: 'Example skill', status: 'imported', manifest_json: { package_hash: 'b'.repeat(64) }, pending_proposal: null } as unknown as SkillPackage
beforeEach(() => {
  vi.clearAllMocks()
  space.role = 'owner'
  vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [], total: 0 } as never)
  vi.mocked(capabilitiesFrameworkApi.getSkillPackage).mockResolvedValue(pkg)
  vi.mocked(capabilitiesFrameworkApi.getSkillContent).mockResolvedValue({ files: [] } as never)
  vi.mocked(capabilitiesFrameworkApi.listSkillBindings).mockResolvedValue([])
  vi.mocked(capabilitiesFrameworkApi.previewSkillImport).mockResolvedValue(preview)
  vi.mocked(capabilitiesFrameworkApi.importSkill).mockResolvedValue(pkg)
  vi.mocked(capabilitiesFrameworkApi.createSkillReviewProposal).mockResolvedValue({ id: 'proposal-1' } as never)
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [{ id: 'host-1', name: 'My laptop', owner_user_id: 'user-1', kind: 'remote', status: 'online' }] } as never)
  vi.mocked(capabilitiesFrameworkApi.scanHostSkills).mockResolvedValue({ items: [skill], warnings: [], truncated: false })
})
async function openImport() {
  await screen.findByText('Your Skill library is empty')
  fireEvent.click(screen.getAllByRole('button', { name: 'Import Skill' })[0]!)
  return screen.findByRole('dialog')
}
async function chooseTab(name: string) {
  await userEvent.click(screen.getByRole('tab', { name }))
}

describe('Skill library', () => {
  it('has one useful empty state and separates import controls from the library', async () => {
    render(<SkillsPage />)
    await screen.findByText('Your Skill library is empty')
    expect(screen.queryByPlaceholderText(/github\.com/)).not.toBeInTheDocument()
    expect(screen.queryByText('Select a Skill to inspect its original files and usage scopes.')).not.toBeInTheDocument()
    expect(hostsApi.list).not.toHaveBeenCalled()
  })
  it('automatically discovers global CLI Skills and imports the selected pinned package without a Project Folder', async () => {
    render(<SkillsPage />)
    const dialog = await openImport()
    fireEvent.click(await screen.findByRole('radio', { name: /Review code/ }))
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    expect(capabilitiesFrameworkApi.previewSkillImport).toHaveBeenCalledWith({ source_type: 'local_workspace', host_id: 'host-1', skill_id: skill.id }, expect.objectContaining({ spaceId: 'space-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({ source_type: 'local_workspace', host_id: 'host-1', skill_id: skill.id, package_hash: preview.package_hash }, expect.objectContaining({ spaceId: 'space-1' })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // One proposal reviews the import and enables it Space-wide.
    expect(capabilitiesFrameworkApi.createSkillReviewProposal).toHaveBeenCalledWith('package-1',
      { binding: { scope_type: 'space', scope_id: null, enabled: true } }, expect.objectContaining({ spaceId: 'space-1' }))
  })
  it('imports only, without filing a review, when enablement is deferred', async () => {
    render(<SkillsPage />)
    const dialog = await openImport()
    fireEvent.click(await screen.findByRole('radio', { name: /Review code/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.change(screen.getByRole('combobox', { name: /After import, enable for/ }), { target: { value: 'none' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalled()
    expect(capabilitiesFrameworkApi.createSkillReviewProposal).not.toHaveBeenCalled()
  })
  it('defaults an ordinary member to their own scope and does not offer the Space scope', async () => {
    space.role = 'member'
    render(<SkillsPage />)
    const dialog = await openImport()
    fireEvent.click(await screen.findByRole('radio', { name: /Review code/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    expect(screen.getByRole('combobox', { name: /After import, enable for/ })).toHaveValue('user')
    expect(screen.queryByRole('option', { name: 'This Space' })).not.toBeInTheDocument()
    expect(screen.getByText('Only a Space owner or admin can enable a Skill for the whole Space.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(capabilitiesFrameworkApi.createSkillReviewProposal).toHaveBeenCalledWith('package-1',
      { binding: { scope_type: 'user', scope_id: 'user-1', enabled: true } }, expect.objectContaining({ spaceId: 'space-1' }))
  })
  it('files the review alone and explains inline when enabling cannot be requested after import', async () => {
    vi.mocked(capabilitiesFrameworkApi.createSkillReviewProposal).mockRejectedValueOnce(new Error('403 Space skill overlays are set by a Space owner or admin'))
    render(<SkillsPage />)
    const dialog = await openImport()
    fireEvent.click(await screen.findByRole('radio', { name: /Review code/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/sent for review, but enabling could not be requested \(403 Space skill overlays/)
    expect(capabilitiesFrameworkApi.createSkillReviewProposal).toHaveBeenLastCalledWith('package-1', {}, expect.objectContaining({ spaceId: 'space-1' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Closing hands the kept import to the library, which opens it.
    await waitFor(() => expect(capabilitiesFrameworkApi.getSkillPackage).toHaveBeenCalledWith('package-1', expect.anything()))
  })
  it('withdraws preview when the GitHub URL changes', async () => {
    render(<SkillsPage />); await openImport(); await chooseTab('GitHub')
    const url = screen.getByPlaceholderText(/github\.com/)
    fireEvent.change(url, { target: { value: 'https://github.com/org/repo/tree/main/one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.change(url, { target: { value: 'https://github.com/org/repo/tree/main/two' } })
    expect(screen.queryByText('Previewed skill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import and request enablement' })).not.toBeInTheDocument()
  })
  it('shows a styled ZIP picker, filename and exact upload bytes', async () => {
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    fireEvent.change(screen.getByLabelText('Import a Markdown or ZIP file'), { target: { files: [new File(['bytes'], 'example.zip', { type: 'application/zip' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    expect(screen.getByRole('button', { name: /example.zip/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    expect(capabilitiesFrameworkApi.previewSkillImport).toHaveBeenCalledWith({ source_type: 'upload', archive_base64: btoa('bytes') }, expect.anything())
  })
  it.each(['picker', 'drop'])('imports a standalone Markdown Skill through the %s without changing its bytes', async method => {
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    const markdown = '\ufeff---\r\nname: review\r\ndescription: 代码审查\r\n---\r\n审查代码。\r\n'
    const file = new File([markdown], '代码审查.MD', { type: 'text/plain' })
    if (method === 'picker') fireEvent.change(screen.getByLabelText('Import a Markdown or ZIP file'), { target: { files: [file] } })
    else fireEvent.drop(screen.getByRole('tabpanel', { name: 'Files' }), { dataTransfer: { files: [file] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    expect(screen.getByRole('button', { name: /代码审查.MD/ })).toBeVisible()
    expect(capabilitiesFrameworkApi.previewSkillImport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    const source = { source_type: 'upload', files: [{ path: 'SKILL.md', content_base64: btoa(String.fromCharCode(...new TextEncoder().encode(markdown))) }] }
    expect(capabilitiesFrameworkApi.previewSkillImport).toHaveBeenCalledWith(source, expect.objectContaining({ spaceId: 'space-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({ ...source, package_hash: preview.package_hash }, expect.objectContaining({ spaceId: 'space-1' })))
  })
  it('withdraws the ZIP preview when replaced by Markdown and imports only the new previewed file', async () => {
    vi.mocked(capabilitiesFrameworkApi.previewSkillImport).mockResolvedValueOnce(preview)
      .mockResolvedValueOnce({ ...preview, package_hash: 'c'.repeat(64) })
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    fireEvent.change(screen.getByLabelText('Import a Markdown or ZIP file'), { target: { files: [new File(['original'], 'original.zip')] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.drop(screen.getByRole('tabpanel', { name: 'Files' }), { dataTransfer: { files: [new File(['replacement'], 'SKILL.md')] } })
    expect(screen.queryByText('Previewed skill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import and request enablement' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({ source_type: 'upload', files: [{ path: 'SKILL.md', content_base64: btoa('replacement') }], package_hash: 'c'.repeat(64) }, expect.anything()))
  })
  it('highlights nested drag targets and previews and imports the exact dropped ZIP bytes', async () => {
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    const zone = screen.getByRole('tabpanel', { name: 'Files' })
    const dataTransfer = { types: ['Files'], files: [new File([new Uint8Array([0, 127, 255])], 'skill.ZIP')], dropEffect: 'none' }
    fireEvent.dragEnter(zone, { dataTransfer })
    const prompt = screen.getByText('Drop the file here')
    fireEvent.dragEnter(prompt, { dataTransfer })
    fireEvent.dragLeave(prompt, { dataTransfer })
    expect(screen.getByText('Drop the file here')).toBeVisible()
    fireEvent.dragLeave(zone, { dataTransfer })
    expect(screen.getByText('Drag a Markdown or ZIP file here, or click to choose')).toBeVisible()
    fireEvent.dragEnter(zone, { dataTransfer })
    expect(fireEvent.dragOver(zone, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(zone, { dataTransfer })).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    expect(screen.getByRole('button', { name: /skill.ZIP/ })).toBeVisible()
    expect(capabilitiesFrameworkApi.previewSkillImport).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    const source = { source_type: 'upload', archive_base64: btoa('\x00\x7f\xff') }
    expect(capabilitiesFrameworkApi.previewSkillImport).toHaveBeenCalledWith(source, expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({ ...source, package_hash: preview.package_hash }, expect.anything()))
  })
  it.each([
    { files: [new File(['one'], 'one.zip'), new File(['two'], 'two.zip')], error: 'Choose one Markdown or ZIP file at a time.' },
    { files: [new File(['text'], 'skill.txt', { type: 'application/zip' })], error: 'Choose a Markdown (.md) or ZIP (.zip) file.' },
    { files: [new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'oversized.zip')], error: 'ZIP up to 3 MB' },
    { files: [new File([new Uint8Array(256 * 1024 + 1)], 'SKILL.md')], error: 'A Markdown Skill file may be up to 256 KB.' },
    { files: [new File(['one'], 'SKILL.md'), new File(['two'], 'package.zip')], error: 'Choose one Markdown or ZIP file at a time.' },
  ])('rejects invalid drops ($error) and withdraws the previous preview', async ({ files, error }) => {
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    fireEvent.change(screen.getByLabelText('Import a Markdown or ZIP file'), { target: { files: [new File(['bytes'], 'original.zip')] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    fireEvent.drop(screen.getByRole('tabpanel', { name: 'Files' }), { dataTransfer: { files } })
    expect(await screen.findByRole('alert')).toHaveTextContent(error)
    expect(screen.queryByText('Previewed skill')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import and request enablement' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled()
    expect(capabilitiesFrameworkApi.importSkill).not.toHaveBeenCalled()
  })
  it('ignores dropped replacements while the selected ZIP is being previewed', async () => {
    let finish!: (value: SkillImportPreviewResponse) => void
    vi.mocked(capabilitiesFrameworkApi.previewSkillImport).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    render(<SkillsPage />); await openImport(); await chooseTab('Files')
    fireEvent.change(screen.getByLabelText('Import a Markdown or ZIP file'), { target: { files: [new File(['original'], 'original.zip')] } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const zone = screen.getByRole('tabpanel', { name: 'Files' })
    const dataTransfer = { types: ['Files'], files: [new File(['replacement'], 'replacement.zip')], dropEffect: 'copy' }
    expect(fireEvent.dragOver(zone, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('none')
    expect(fireEvent.drop(zone, { dataTransfer })).toBe(false)
    expect(screen.getByRole('button', { name: /original.zip/ })).toBeDisabled()
    await act(async () => { finish(preview) })
    fireEvent.click(screen.getByRole('button', { name: 'Import and request enablement' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.importSkill).toHaveBeenCalledWith({ source_type: 'upload', archive_base64: btoa('original'), package_hash: preview.package_hash }, expect.anything()))
  })
  it('shows scan failures and supports rescanning', async () => {
    vi.mocked(capabilitiesFrameworkApi.scanHostSkills).mockRejectedValueOnce(new Error('Host needs update'))
    render(<SkillsPage />); await openImport()
    expect(await screen.findByRole('alert')).toHaveTextContent('Host needs update')
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(await screen.findByRole('radio', { name: /Review code/ })).toBeVisible()
  })
  it('does not let a late scan from the previous Host replace the current candidates', async () => {
    let finish!: (value: Awaited<ReturnType<typeof capabilitiesFrameworkApi.scanHostSkills>>) => void
    vi.mocked(capabilitiesFrameworkApi.scanHostSkills).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ items: [{ ...skill, id: 'c'.repeat(64), name: 'Second Host Skill' }], warnings: [], truncated: false })
    vi.mocked(hostsApi.list).mockResolvedValueOnce({ items: [
      { id: 'host-1', owner_user_id: 'user-1', name: 'First Host', kind: 'remote', status: 'online' },
      { id: 'host-2', owner_user_id: 'user-1', name: 'Second Host', kind: 'remote', status: 'online' },
    ] } as never)
    render(<SkillsPage />); await openImport()
    await waitFor(() => expect(capabilitiesFrameworkApi.scanHostSkills).toHaveBeenCalledWith('host-1', expect.anything()))
    fireEvent.click(screen.getByRole('button', { name: 'Execution Host' }))
    fireEvent.click(screen.getByRole('option', { name: /Second Host/ }))
    expect(await screen.findByRole('radio', { name: /Second Host Skill/ })).toBeVisible()
    await act(async () => { finish({ items: [skill], truncated: false, warnings: [] }) })
    expect(screen.queryByRole('radio', { name: /Review code/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Second Host Skill/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Previewed skill')
    expect(capabilitiesFrameworkApi.previewSkillImport).toHaveBeenCalledWith({ source_type: 'local_workspace', host_id: 'host-2', skill_id: 'c'.repeat(64) }, expect.anything())
  })
  it('distinguishes no connected Hosts from an empty scan', async () => {
    vi.mocked(hostsApi.list).mockResolvedValueOnce({ items: [] })
    render(<SkillsPage />); await openImport()
    expect(await screen.findByText('Connect a personal Host to discover its global Skills.')).toBeVisible()
    expect(capabilitiesFrameworkApi.scanHostSkills).not.toHaveBeenCalled()
  })
  it('automatically opens the first existing Skill and approves its pending review in place', async () => {
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [pkg], total: 1 } as never)
    vi.mocked(capabilitiesFrameworkApi.getSkillPackage).mockResolvedValueOnce({ ...pkg, pending_proposal: { id: 'proposal-1', operation: 'skill_import_approve' } })
    render(<SkillsPage />)
    expect(await screen.findByText('One step left: waiting for approval')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review and enable' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(proposalsApi.accept).toHaveBeenCalledWith('proposal-1', expect.objectContaining({ spaceId: 'space-1' })))
    await waitFor(() => expect(screen.queryByText('One step left: waiting for approval')).not.toBeInTheDocument())
  })
  it('reviews and enables an unreviewed Skill for the Space with one proposal', async () => {
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [pkg], total: 1 } as never)
    render(<SkillsPage />)
    expect(await screen.findByRole('combobox', { name: 'Usage scope' })).toHaveValue('space')
    expect(screen.queryByRole('option', { name: 'Project' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }))
    await waitFor(() => expect(capabilitiesFrameworkApi.createSkillReviewProposal).toHaveBeenCalledWith('package-1',
      { binding: { scope_type: 'space', scope_id: null, enabled: true } }, expect.objectContaining({ spaceId: 'space-1' })))
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeEnabled()
  })
  it('offers a member only their own scopes on an unreviewed package', async () => {
    space.role = 'member'
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [pkg], total: 1 } as never)
    render(<SkillsPage />)
    expect(await screen.findByRole('combobox', { name: 'Usage scope' })).toHaveValue('user')
    expect(screen.queryByRole('option', { name: 'This Space' })).not.toBeInTheDocument()
  })
  it('shows the other pending request in place when a different review is already pending', async () => {
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockResolvedValue({ items: [pkg], total: 1 } as never)
    vi.mocked(capabilitiesFrameworkApi.createSkillReviewProposal).mockRejectedValueOnce(
      new ApiRequestError('Your other pending proposal for this package must be decided first', 409, 'skill_review_pending', { proposal_id: 'proposal-9' }))
    render(<SkillsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review and enable' }))
    expect(await screen.findByText('You already have a different pending request for this package. Decide it before requesting another.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(proposalsApi.accept).toHaveBeenCalledWith('proposal-9', expect.objectContaining({ spaceId: 'space-1' })))
  })
  it('reports refresh failures without claiming success', async () => {
    render(<SkillsPage />); await screen.findByText('Your Skill library is empty')
    vi.mocked(capabilitiesFrameworkApi.listSkillPackages).mockRejectedValueOnce(new Error('503 unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('503 unavailable')
  })
  it('translates import and discovery controls in Chinese', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN') })
    try {
      render(<SkillsPage />); await screen.findByText('技能库还没有 Skill')
      fireEvent.click(screen.getAllByRole('button', { name: '导入 Skill' })[0]!)
      expect(await screen.findByRole('tab', { name: '本地 CLI' })).toBeVisible()
      expect(await screen.findByRole('radio', { name: /Review code/ })).toBeVisible()
      expect(screen.getByRole('button', { name: '重新扫描' })).toBeVisible()
      await chooseTab('文件上传')
      expect(screen.getByText('将 Markdown 或 ZIP 拖到这里，或点击选择')).toBeVisible()
      fireEvent.drop(screen.getByRole('tabpanel', { name: '文件上传' }), { dataTransfer: { files: [new File(['text'], 'skill.txt')] } })
      expect(await screen.findByRole('alert')).toHaveTextContent('请选择 Markdown（.md）或 ZIP（.zip）文件。')
    } finally { await act(async () => { await i18n.changeLanguage('en') }) }
  })
})
