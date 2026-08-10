import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const { getPolicy, updatePolicy, accessLogs, discloseDemotion, members, createPublication, useSpaceMock } = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  accessLogs: vi.fn(),
  discloseDemotion: vi.fn(),
  members: vi.fn(),
  createPublication: vi.fn(),
  useSpaceMock: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  contentAccessApi: { get: getPolicy, update: updatePolicy, accessLogs, discloseDemotion },
  spacesApi: { members },
  publicationsApi: { create: createPublication },
}))

vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: useSpaceMock,
}))

import { ContentAccessControl } from '../ContentAccessControl'

const DEFAULT_SPACES = [
  { id: 'space-1', name: 'Source space', type: 'team', role: 'member', oversight_mode: 'none' },
  { id: 'space-2', name: 'Target space', type: 'team', role: 'member', oversight_mode: 'none' },
]

beforeEach(() => {
  useSpaceMock.mockReset()
  useSpaceMock.mockReturnValue({ activeSpaceId: 'space-1', userId: 'user-1', spaces: DEFAULT_SPACES })
  getPolicy.mockReset()
  updatePolicy.mockReset()
  accessLogs.mockReset()
  discloseDemotion.mockReset()
  members.mockReset()
  createPublication.mockReset()
})

const policy = {
  resource_type: 'artifact',
  resource_id: 'artifact-1',
  space_id: 'space-1',
  owner_user_id: 'user-1',
  visibility: 'private' as const,
  access_level: 'full' as const,
  project_folder_id: null,
  project_id: null,
  grants: [],
}

describe('ContentAccessControl', () => {
  it('updates selected-user policy and publishes only to selected member spaces', async () => {
    getPolicy.mockResolvedValue(policy)
    updatePolicy.mockImplementation(async (_type, _id, body) => ({ ...policy, ...body }))
    members.mockResolvedValue([
      { user_id: 'user-1', display_name: 'Owner', email: 'owner@example.test', avatar_url: null, role: 'member', joined_at: '' },
      { user_id: 'user-2', display_name: 'Teammate', email: 'member@example.test', avatar_url: null, role: 'member', joined_at: '' },
    ])
    createPublication.mockResolvedValue({ id: 'publication-1' })

    render(<MemoryRouter><ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" /></MemoryRouter>)

    expect(getPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')
    await screen.findByText('Only me')

    fireEvent.click(screen.getByRole('button', { name: 'Selected people' }))
    fireEvent.click(await screen.findByLabelText('Teammate'))
    const disclosure = screen.getByRole('group', { name: 'Disclosure level' })
    fireEvent.click(within(disclosure).getByRole('button', { name: 'Summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith('artifact', 'artifact-1', {
      visibility: 'selected_users',
      access_level: 'summary',
      project_id: null,
      grants: [{ user_id: 'user-2', access_level: 'full' }],
    }))

    fireEvent.click(screen.getByLabelText('Target space'))
    fireEvent.click(screen.getByRole('button', { name: 'Publish snapshot' }))
    await waitFor(() => expect(createPublication).toHaveBeenCalledWith({
      resource_type: 'artifact',
      resource_id: 'artifact-1',
      target_space_ids: ['space-2'],
    }))
  })

  it('does not render an admin-only read bypass for an ordinary non-owner', () => {
    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-9" />)
    expect(screen.queryByRole('button', { name: 'Access' })).not.toBeInTheDocument()
  })

  it('offers a disclosure-upgrade member picker for space_shared at a summary base, and includes grants on save', async () => {
    getPolicy.mockResolvedValue({ ...policy, visibility: 'space_shared', access_level: 'summary' })
    updatePolicy.mockImplementation(async (_type, _id, body) => ({ ...policy, ...body }))
    members.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Teammate', email: 'member@example.test', avatar_url: null, role: 'member', joined_at: '' },
    ])

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')
    await screen.findByText(/Disclosure upgrades/)

    fireEvent.click(await screen.findByLabelText('Teammate'))
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith('artifact', 'artifact-1', {
      visibility: 'space_shared',
      access_level: 'summary',
      project_id: null,
      grants: [{ user_id: 'user-2', access_level: 'full' }],
    }))
  })

  it('hides the member picker for space_shared at a full base — grants can never downgrade below it', async () => {
    getPolicy.mockResolvedValue({ ...policy, visibility: 'space_shared', access_level: 'full' })
    members.mockResolvedValue([
      { user_id: 'user-2', display_name: 'Teammate', email: 'member@example.test', avatar_url: null, role: 'member', joined_at: '' },
    ])

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')

    expect(screen.queryByText(/Disclosure upgrades/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Teammate')).not.toBeInTheDocument()
  })

  it('shows a persistent oversight hint on private/selected_users choices when the Space has oversight enabled', async () => {
    useSpaceMock.mockReturnValue({
      activeSpaceId: 'space-1',
      userId: 'user-1',
      spaces: [{ id: 'space-1', name: 'Source space', type: 'team', role: 'member', oversight_mode: 'content' }],
    })
    getPolicy.mockResolvedValue(policy)
    members.mockResolvedValue([])

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')

    expect(await screen.findByText(/Space admins can view this content \(oversight: content\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Whole Space' }))
    expect(screen.queryByText(/Space admins can view this content/)).not.toBeInTheDocument()
  })

  it('shows no oversight hint when the active Space has oversight_mode=none', async () => {
    getPolicy.mockResolvedValue(policy)
    members.mockResolvedValue([])

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')

    expect(screen.queryByText(/Space admins can view this content/)).not.toBeInTheDocument()
  })

  it('maps the visible ladder to Project scope and whole-Space scope', async () => {
    getPolicy.mockResolvedValue({ ...policy, project_id: 'project-1', visibility: 'space_shared' })
    updatePolicy.mockImplementation(async (_type, _id, body) => ({ ...policy, ...body }))
    members.mockResolvedValue([])

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')

    fireEvent.click(screen.getByRole('button', { name: 'Whole Space' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith('artifact', 'artifact-1', {
      visibility: 'space_shared',
      access_level: 'full',
      project_id: null,
      grants: [],
    }))
  })

  it('shows readers, consuming Runs, and still-shared outputs before confirming a demotion', async () => {
    getPolicy.mockResolvedValue({ ...policy, visibility: 'space_shared' })
    members.mockResolvedValue([])
    discloseDemotion.mockResolvedValue({
      confirmation_id: 'confirmation-1',
      expires_at: '2026-08-07T12:15:00.000Z',
      resource_type: 'artifact',
      resource_id: 'artifact-1',
      target_visibility: 'private',
      exposure: {
        readers: [{ user_id: 'user-2', display_name: 'Reader', access_count: 2, last_accessed_at: '2026-08-07T12:00:00.000Z', link: '/space-settings' }],
        consuming_runs: [{ run_id: 'run-1', title: 'Research run', status: 'succeeded', link: '/runs/run-1' }],
        shared_derived_outputs: [{ resource_type: 'artifact', id: 'derived-1', title: 'Shared report', visibility: 'space_shared', link: '/artifacts/derived-1' }],
      },
    })
    updatePolicy.mockImplementation(async (_type, _id, body) => ({ ...policy, ...body }))

    render(<MemoryRouter><ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')
    fireEvent.click(screen.getByRole('button', { name: 'Only me' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))

    expect(await screen.findByText('Reader (2 reads)')).toBeInTheDocument()
    expect(screen.getByText('Research run (succeeded)')).toBeInTheDocument()
    expect(screen.getByText('Shared report (space_shared)')).toBeInTheDocument()
    expect(updatePolicy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm demotion' }))
    await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith('artifact', 'artifact-1', {
      visibility: 'private',
      access_level: 'full',
      project_id: null,
      grants: [],
      demotion_confirmation_id: 'confirmation-1',
    }))
  })
})
