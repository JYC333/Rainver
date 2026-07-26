import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPolicy, updatePolicy, members, createPublication, useSpaceMock } = vi.hoisted(() => ({
  getPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  members: vi.fn(),
  createPublication: vi.fn(),
  useSpaceMock: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  contentAccessApi: { get: getPolicy, update: updatePolicy },
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

    render(<ContentAccessControl resourceType="artifact" resourceId="artifact-1" ownerUserId="user-1" />)

    expect(getPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Access' }))
    await screen.findByText('Content access')
    await screen.findByText('Private')

    fireEvent.click(screen.getByRole('button', { name: 'Selected members' }))
    fireEvent.click(await screen.findByLabelText('Teammate'))
    const disclosure = screen.getByRole('group', { name: 'Disclosure level' })
    fireEvent.click(within(disclosure).getByRole('button', { name: 'Summary' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))

    await waitFor(() => expect(updatePolicy).toHaveBeenCalledWith('artifact', 'artifact-1', {
      visibility: 'selected_users',
      access_level: 'summary',
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

    fireEvent.click(screen.getByRole('button', { name: 'Space members' }))
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
})
