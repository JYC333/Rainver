import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import type { GmailApplicationExecutionOptions } from '@rainver/protocol'
import { ApiRequestError } from '../../../api/transport'
const api = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn(), reject: vi.fn() }))
const gmail = vi.hoisted(() => ({ applicationExecutionOptions: vi.fn(), selectApplicationExecution: vi.fn() }))
vi.mock('../../../api/client', () => ({ proposalsApi: api }))
vi.mock('../../../api/gmail', () => ({ gmailApi: gmail }))
vi.mock('../../../core/spaceNav', async () => ({ SpaceLink: (await import('react-router-dom')).Link }))
import { ActionPreviewCards } from '../ActionPreviewCard'
import { ConversationScope } from '../ConversationScope'
import type { ChatActionPreview } from '../../../types/api'

// ADR 0036: the owner chooses the Agent and model of their application updates on the card itself.
const preview: ChatActionPreview = {
  action_id: 'source.gmail.application_updates.propose', proposal_id: 'card-1', proposal_type: 'gmail_digest_create', status: 'proposed',
  title: 'Automatic application updates from Gmail · owner@gmail.example', summary: 'Mailbox owner@gmail.example: the Agent and model you choose on this card…',
  decidable_by_user_id: 'owner', risk_level: 'high', scope: { project_id: 'project-1' },
}
type Configuration = GmailApplicationExecutionOptions['configurations'][number]
const configuration = (extra: Partial<Configuration>): Configuration => ({
  agent_id: 'agent-codex', agent_name: 'Coder', agent_kind: 'standard', runtime_profile_id: 'profile-1', profile_name: 'Codex', runtime_key: 'codex_cli',
  backend_mode: 'runtime_native', available: false, reason: 'host_offline', models: [], omitted_models: 0, models_cursor: null, ...extra,
})
const model = (name: string, extra: Partial<Configuration['models'][number]> = {}) => ({ model: name, name: null, ...extra })
const provider = configuration({ agent_id: 'assistant', agent_name: 'Project helper', agent_kind: 'system_assistant', runtime_profile_id: 'profile-2', profile_name: 'Provider',
  runtime_key: 'opencode', backend_mode: 'model_provider', available: true, reason: null, models: [model('provider-model-1')] })
const native = configuration({ agent_id: 'agent-native', agent_name: 'Writer', runtime_profile_id: 'profile-3', profile_name: 'Laptop', runtime_key: 'claude_code',
  available: true, reason: null, models: [model('full-model-a'), model('full-model-b'), model('opus', { name: 'Opus' })] })
const REVISION = (c: string) => c.repeat(64)
const options = (selected: GmailApplicationExecutionOptions['selected'], summary: string, revision = REVISION('a'), configurations: Configuration[] = [configuration({}), provider]): GmailApplicationExecutionOptions => ({
  proposal_id: 'card-1', applies: true, selected, summary, next_cursor: null, card_revision: revision,
  scope: { mailbox_email: 'owner@gmail.example', effects: ['interview', 'deadline'], results_to: 'room', room_title: 'Admissions', reader_names: ['Owner', 'Peer'], reader_count: 3 },
  configurations,
})
const show = (onDecision = vi.fn(async () => {})) => render(<MemoryRouter><ConversationScope spaceId="space-1"><ActionPreviewCards previews={[preview]} viewerUserId="owner" onDecision={onDecision} /></ConversationScope></MemoryRouter>)
beforeEach(() => {
  vi.resetAllMocks()
  api.get.mockResolvedValue({ id: 'card-1', status: 'pending', expired: false })
})
const pick = async (box: HTMLElement, level: 'Agent and runtime' | 'Model', option: string) => {
  fireEvent.click(within(box).getByRole('button', { name: level }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

it('shows the scope, lists an unavailable configuration once with its reason, and accepts only once a configuration and its model are chosen', async () => {
  gmail.applicationExecutionOptions.mockResolvedValue(options(null, 'No Agent and model is chosen yet.'))
  gmail.selectApplicationExecution.mockResolvedValue(options({ agent_id: 'assistant', runtime_profile_id: 'profile-2', model: 'provider-model-1' }, 'Assistant on provider-model-1 reads each new inbox message.', REVISION('b')))
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  const onDecision = vi.fn(async () => {})
  show(onDecision)
  const box = await screen.findByTestId('gmail-application-execution')
  expect(within(box).getByText('Mailbox: owner@gmail.example')).toBeInTheDocument()
  expect(within(box).getByText(/interview invitations, new or moved deadlines/)).toBeInTheDocument()
  expect(within(box).getByText(/posted in the Room “Admissions”, read now by Owner, Peer and 1 more/)).toBeInTheDocument()
  expect(within(box).getAllByText(/its execution Host is offline/)).toHaveLength(1)
  expect(within(box).getByText(/Coder · Codex: its execution Host is offline/)).toBeInTheDocument()
  // The model level appears only once a configuration is chosen.
  expect(within(box).queryByRole('button', { name: 'Model' })).toBeNull()
  const accept = screen.getByRole('button', { name: 'Accept' })
  expect(accept).toBeDisabled()
  await pick(box, 'Agent and runtime', 'Project helper (Assistant) · Provider')
  expect(gmail.selectApplicationExecution).not.toHaveBeenCalled()
  expect(accept).toBeDisabled()
  await pick(box, 'Model', 'provider-model-1')
  await waitFor(() => expect(gmail.selectApplicationExecution).toHaveBeenCalledWith('card-1',
    { agent_id: 'assistant', runtime_profile_id: 'profile-2', model: 'provider-model-1' }, expect.any(String), expect.objectContaining({ spaceId: 'space-1' })))
  expect(await screen.findByText('Assistant on provider-model-1 reads each new inbox message.')).toBeInTheDocument()
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  // Accepting names the revision the card shows now: the one its saved choice returned.
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('b') })))
  expect(await screen.findByText('Change confirmed and saved.')).toBeInTheDocument()
  expect(onDecision).not.toHaveBeenCalled()
})

it('echoes the saved choice on both levels; another configuration clears the model and blocks accepting until its model is saved with a new revision', async () => {
  const saved = { agent_id: 'assistant', runtime_profile_id: 'profile-2', model: 'provider-model-1' }
  gmail.applicationExecutionOptions.mockResolvedValue(options(saved, 'Assistant on provider-model-1.', REVISION('a'), [provider, native]))
  gmail.selectApplicationExecution.mockResolvedValue(options({ agent_id: 'agent-native', runtime_profile_id: 'profile-3', model: 'full-model-b' }, 'Writer on full-model-b.', REVISION('c'), [provider, native]))
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toHaveTextContent('Project helper (Assistant) · Provider')
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('provider-model-1')
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  // Another configuration: its model is not chosen yet, and the card cannot be accepted on the old one meanwhile.
  await pick(box, 'Agent and runtime', 'Writer · Laptop')
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('Choose a model')
  expect(accept).toBeDisabled()
  fireEvent.click(accept)
  expect(api.accept).not.toHaveBeenCalled()
  // Every model its conversation's picker offers is listed — an alias too, under the runtime's own name for it.
  fireEvent.click(within(box).getByRole('button', { name: 'Model' }))
  expect(await screen.findByRole('option', { name: 'Opus (opus)' })).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('option', { name: 'full-model-b' }))
  await waitFor(() => expect(gmail.selectApplicationExecution).toHaveBeenCalledWith('card-1',
    { agent_id: 'agent-native', runtime_profile_id: 'profile-3', model: 'full-model-b' }, expect.any(String), expect.objectContaining({ spaceId: 'space-1' })))
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('c') })))
})

it('keeps the card open but not acceptable when nothing can run it', async () => {
  gmail.applicationExecutionOptions.mockResolvedValue(options(null, 'No Agent and model is chosen yet.', REVISION('a'), [configuration({})]))
  show()
  expect(await screen.findByText(/No Agent and model in this Project can run this in the background yet/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Agent and runtime' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled()
})

const selected = { agent_id: 'assistant', runtime_profile_id: 'profile-2', model: 'provider-model-1' }

it('accepts nothing while a choice is being saved, and shows only the latest answer when an earlier one arrives late', async () => {
  gmail.applicationExecutionOptions.mockResolvedValue(options(null, 'No Agent and model is chosen yet.', REVISION('a'), [provider, native]))
  let finish: (out: GmailApplicationExecutionOptions) => void = () => {}
  let fail: (error: Error) => void = () => {}
  gmail.selectApplicationExecution.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  await pick(box, 'Agent and runtime', 'Project helper (Assistant) · Provider')
  await pick(box, 'Model', 'provider-model-1')
  expect(await within(box).findByText('Checking your choice…')).toBeInTheDocument()
  const accept = screen.getByRole('button', { name: 'Accept' })
  expect(accept).toBeDisabled()
  // Both levels are locked while it is saved.
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toBeDisabled()
  fireEvent.click(accept)
  expect(api.accept).not.toHaveBeenCalled()
  // The save is refused: the card is reloaded as it stands, and only that answer counts.
  gmail.applicationExecutionOptions.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  fail(new Error('Host went offline'))
  expect(await within(box).findByText(/Could not use this Agent and model: Host went offline/)).toBeInTheDocument()
  expect(accept).toBeDisabled()
  finish(options(selected, 'Assistant on provider-model-1, as saved in another tab.', REVISION('d'), [provider, native]))
  expect(await screen.findByText('Assistant on provider-model-1, as saved in another tab.')).toBeInTheDocument()
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('d') })))
})

it('continues the configuration list past its first page and chooses a configuration found only there', async () => {
  const later = configuration({ agent_id: 'agent-late', agent_name: 'Late agent', runtime_profile_id: 'profile-9', profile_name: 'Late', available: true, reason: null, models: [model('late-model-1')] })
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce({ ...options(null, 'No Agent and model is chosen yet.'), next_cursor: '1.20261123000000000000.YWdlbnQtNTE.0' })
    .mockResolvedValueOnce({ ...options(null, 'No Agent and model is chosen yet.', REVISION('a'), [later]), next_cursor: null })
  gmail.selectApplicationExecution.mockResolvedValue(options({ agent_id: 'agent-late', runtime_profile_id: 'profile-9', model: 'late-model-1' }, 'Late agent on late-model-1.', REVISION('e'), [later]))
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  fireEvent.click(within(box).getByRole('button', { name: 'Show more Agents and runtimes' }))
  await waitFor(() => expect(gmail.applicationExecutionOptions).toHaveBeenLastCalledWith('card-1', expect.objectContaining({ spaceId: 'space-1' }), '1.20261123000000000000.YWdlbnQtNTE.0'))
  await waitFor(() => expect(within(box).queryByRole('button', { name: 'Show more Agents and runtimes' })).toBeNull())
  fireEvent.click(within(box).getByRole('button', { name: 'Agent and runtime' }))
  // The first page's Assistant is still offered beside the configuration of the later page.
  expect(await screen.findByRole('option', { name: 'Project helper (Assistant) · Provider' })).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('option', { name: 'Late agent · Late' }))
  await pick(box, 'Model', 'late-model-1')
  await waitFor(() => expect(gmail.selectApplicationExecution).toHaveBeenCalledWith('card-1',
    { agent_id: 'agent-late', runtime_profile_id: 'profile-9', model: 'late-model-1' }, expect.any(String), expect.objectContaining({ spaceId: 'space-1' })))
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('e') })))
})

const CURSOR = '1.20261123000000000000.YWdlbnQtNTE.0'
const later = configuration({ agent_id: 'agent-late', agent_name: 'Late agent', runtime_profile_id: 'profile-9', profile_name: 'Late', available: true, reason: null, models: [model('late-model-1')] })
const deferred = () => {
  let resolve: (out: GmailApplicationExecutionOptions) => void = () => {}
  const promise = new Promise<GmailApplicationExecutionOptions>(done => { resolve = done })
  return { promise, resolve }
}

it('accepts nothing while a further page loads, then accepts the shown choice again on its revision', async () => {
  const page = deferred()
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce({ ...options(selected, 'Assistant on provider-model-1.', REVISION('a'), [provider, native]), next_cursor: CURSOR })
    .mockReturnValueOnce(page.promise)
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(within(box).getByRole('button', { name: 'Show more Agents and runtimes' }))
  // The page is still loading: the card it may change cannot be accepted meanwhile.
  await waitFor(() => expect(accept).toBeDisabled())
  fireEvent.click(accept)
  expect(api.accept).not.toHaveBeenCalled()
  page.resolve({ ...options(selected, 'Assistant on provider-model-1.', REVISION('a'), [later]), next_cursor: null })
  await waitFor(() => expect(accept).toBeEnabled())
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('provider-model-1')
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('a') })))
})

it('keeps the owner’s unsaved switch of configuration when a further page answers for another revision of the card', async () => {
  const page = deferred()
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce({ ...options(selected, 'Assistant on provider-model-1.', REVISION('a'), [provider, native]), next_cursor: CURSOR })
    .mockReturnValueOnce(page.promise)
  gmail.selectApplicationExecution.mockResolvedValue(options({ agent_id: 'agent-native', runtime_profile_id: 'profile-3', model: 'full-model-a' }, 'Writer on full-model-a.', REVISION('g'), [provider, native]))
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(within(box).getByRole('button', { name: 'Show more Agents and runtimes' }))
  // The owner switches configuration while the page loads; another tab saves a choice meanwhile (revision f).
  await pick(box, 'Agent and runtime', 'Writer · Laptop')
  page.resolve({ ...options(selected, 'Chosen in another tab.', REVISION('f'), [later]), next_cursor: null })
  await waitFor(() => expect(within(box).queryByRole('button', { name: 'Show more Agents and runtimes' })).toBeNull())
  // The answer added the later page and the card as it stands, without undoing the switch: still not acceptable.
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toHaveTextContent('Writer · Laptop')
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('Choose a model')
  expect(accept).toBeDisabled()
  expect(gmail.applicationExecutionOptions).toHaveBeenCalledTimes(2)
  await pick(box, 'Model', 'full-model-a')
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('g') })))
})

it('adds the first page when a further page answers for a revision whose saved choice is not listed yet', async () => {
  const chosenLater = { agent_id: 'agent-far', runtime_profile_id: 'profile-far', model: 'far-model-1' }
  const far = configuration({ agent_id: 'agent-far', agent_name: 'Far agent', runtime_profile_id: 'profile-far', profile_name: 'Far', available: true, reason: null, models: [model('far-model-1')] })
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce({ ...options(null, 'No Agent and model is chosen yet.'), next_cursor: CURSOR })
    .mockResolvedValueOnce({ ...options(chosenLater, 'Far agent, chosen in another tab.', REVISION('f'), [later]), next_cursor: null })
    .mockResolvedValueOnce({ ...options(chosenLater, 'Far agent, chosen in another tab.', REVISION('f'), [far, configuration({}), provider]), next_cursor: CURSOR })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  fireEvent.click(within(box).getByRole('button', { name: 'Show more Agents and runtimes' }))
  expect(await screen.findByText('Far agent, chosen in another tab.')).toBeInTheDocument()
  expect(gmail.applicationExecutionOptions).toHaveBeenCalledTimes(3)
  expect(gmail.applicationExecutionOptions).toHaveBeenLastCalledWith('card-1', expect.objectContaining({ spaceId: 'space-1' }))
  await waitFor(() => expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('far-model-1'))
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toHaveTextContent('Far agent · Far')
  // The later page already shown stays; the list continues where that page ended.
  expect(within(box).queryByRole('button', { name: 'Show more Agents and runtimes' })).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled())
})

it('keeps a switch the owner makes while the first page is still being added, even though the page was asked for before it', async () => {
  const chosenLater = { agent_id: 'agent-far', runtime_profile_id: 'profile-far', model: 'far-model-1' }
  const far = configuration({ agent_id: 'agent-far', agent_name: 'Far agent', runtime_profile_id: 'profile-far', profile_name: 'Far', available: true, reason: null, models: [model('far-model-1')] })
  const firstPage = deferred()
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce({ ...options(selected, 'Assistant on provider-model-1.', REVISION('a'), [provider, native]), next_cursor: CURSOR })
    .mockResolvedValueOnce({ ...options(chosenLater, 'Far agent, chosen in another tab.', REVISION('f'), [later]), next_cursor: null })
    .mockReturnValueOnce(firstPage.promise)
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(within(box).getByRole('button', { name: 'Show more Agents and runtimes' }))
  // The further page answered for a revision whose saved choice is not listed: the first page is being added. Meanwhile
  // the owner switches to another configuration of their own.
  await waitFor(() => expect(gmail.applicationExecutionOptions).toHaveBeenCalledTimes(3))
  await pick(box, 'Agent and runtime', 'Writer · Laptop')
  firstPage.resolve({ ...options(chosenLater, 'Far agent, chosen in another tab.', REVISION('f'), [far, provider, native]), next_cursor: CURSOR })
  expect(await screen.findByText('Far agent, chosen in another tab.')).toBeInTheDocument()
  // The answer brings the card as it stands, but the owner's switch stands: no model shown, nothing to accept.
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toHaveTextContent('Writer · Laptop')
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('Choose a model')
  // Every load has answered (the further page was the last): still not acceptable.
  await waitFor(() => expect(within(box).queryByRole('button', { name: /Show more Agents and runtimes|Loading more Agents and runtimes/ })).toBeNull())
  expect(accept).toBeDisabled()
})

it('lists a configuration\'s models afresh when the model its next models continued after is gone, skipping none', async () => {
  const many = { ...native, models: [model('full-model-a')], omitted_models: 2, models_cursor: '1.ZnVsbC1tb2RlbC1h' }
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce(options(null, 'No Agent and model is chosen yet.', REVISION('a'), [provider, many]))
    .mockResolvedValueOnce({ ...options(null, 'No Agent and model is chosen yet.', REVISION('a'), [{ ...native, models: [model('full-model-b'), model('full-model-c')], omitted_models: 0, models_cursor: null }]),
      next_cursor: null, models_restarted: true })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  await pick(box, 'Agent and runtime', 'Writer · Laptop')
  fireEvent.click(within(box).getByRole('button', { name: 'Show more models' }))
  await waitFor(() => expect(within(box).queryByRole('button', { name: 'Show more models' })).toBeNull())
  expect(within(box).queryByText(/more models of this runtime are not shown yet/)).toBeNull()
  // The models are the server's fresh list — full-model-a, no longer offered, is gone and none is skipped.
  fireEvent.click(within(box).getByRole('button', { name: 'Model' }))
  expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Choose a model', 'full-model-b', 'full-model-c'])
})

it('lists more models of a configuration on request and chooses one found only there', async () => {
  const many = { ...native, models: [model('full-model-a')], omitted_models: 2, models_cursor: '1.ZnVsbC1tb2RlbC1h' }
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce(options(null, 'No Agent and model is chosen yet.', REVISION('a'), [provider, many]))
    .mockResolvedValueOnce({ ...options(null, 'No Agent and model is chosen yet.', REVISION('a'), [{ ...native, models: [model('full-model-y'), model('full-model-z')], omitted_models: 0, models_cursor: null }]), next_cursor: null })
  gmail.selectApplicationExecution.mockResolvedValue(options({ agent_id: 'agent-native', runtime_profile_id: 'profile-3', model: 'full-model-z' }, 'Writer on full-model-z.', REVISION('h'),
    [provider, { ...native, models: [model('full-model-z'), model('full-model-a')], omitted_models: 2, models_cursor: '1.ZnVsbC1tb2RlbC1h' }]))
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  await pick(box, 'Agent and runtime', 'Writer · Laptop')
  expect(within(box).getByText('2 more models of this runtime are not shown yet.')).toBeInTheDocument()
  fireEvent.click(within(box).getByRole('button', { name: 'Show more models' }))
  await waitFor(() => expect(gmail.applicationExecutionOptions).toHaveBeenLastCalledWith('card-1', expect.objectContaining({ spaceId: 'space-1' }),
    { agent_id: 'agent-native', runtime_profile_id: 'profile-3', models_cursor: '1.ZnVsbC1tb2RlbC1h' }))
  await waitFor(() => expect(within(box).queryByRole('button', { name: 'Show more models' })).toBeNull())
  // The switch to this configuration survived the answer.
  expect(within(box).getByRole('button', { name: 'Agent and runtime' })).toHaveTextContent('Writer · Laptop')
  await pick(box, 'Model', 'full-model-z')
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('full-model-z')
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ expectedRevision: REVISION('h') })))
})

it('never echoes or accepts a saved model its configuration does not list', async () => {
  gmail.applicationExecutionOptions.mockResolvedValue(options({ agent_id: 'agent-native', runtime_profile_id: 'profile-3', model: 'full-model-unlisted' }, 'Writer on full-model-unlisted.', REVISION('a'), [provider, native]))
  show()
  const box = await screen.findByTestId('gmail-application-execution')
  expect(within(box).getByRole('button', { name: 'Model' })).toHaveTextContent('Choose a model')
  expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
})

// The direct Agent chat (ChatPanel) renders cards without a decision handler: the application card is still chosen
// and accepted on the card itself, on its revision; an ordinary summary card keeps its own standalone confirmation.
const showInChat = (previews: ChatActionPreview[]) =>
  render(<MemoryRouter><ConversationScope spaceId="space-1"><ActionPreviewCards previews={previews} viewerUserId="owner" /></ConversationScope></MemoryRouter>)

it('in the direct Agent chat, chooses and accepts an application card on the card itself, naming its revision', async () => {
  gmail.applicationExecutionOptions.mockResolvedValue(options(selected, 'Assistant on provider-model-1.', REVISION('a')))
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  showInChat([preview])
  expect(await screen.findByTestId('gmail-application-execution')).toBeInTheDocument()
  const accept = screen.getByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('card-1', expect.objectContaining({ spaceId: 'space-1', expectedRevision: REVISION('a') })))
  expect(await screen.findByText('Accepted')).toBeInTheDocument()
})

it('in the direct Agent chat, an ordinary summary card is still confirmed on its own, without a choice or a revision', async () => {
  const summaryCard: ChatActionPreview = { ...preview, action_id: 'source.gmail.digest.propose', proposal_id: 'digest-1', title: 'Daily Gmail summary', summary: 'Every day at 08:00.' }
  api.get.mockResolvedValue({ id: 'digest-1', status: 'pending', expired: false })
  api.accept.mockResolvedValue({ result_type: 'gmail_digest', proposal: { id: 'digest-1', status: 'accepted' } })
  showInChat([summaryCard])
  const accept = await screen.findByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  expect(screen.queryByTestId('gmail-application-execution')).toBeNull()
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenCalledWith('digest-1', expect.not.objectContaining({ expectedRevision: expect.anything() })))
  expect(gmail.applicationExecutionOptions).not.toHaveBeenCalled()
})

it('reloads the card as it stands when acceptance finds it changed since it was shown, and accepts only that revision', async () => {
  gmail.applicationExecutionOptions
    .mockResolvedValueOnce(options(selected, 'Assistant on provider-model-1.', REVISION('a')))
    // Another tab chose again in between: the reload shows the card's current revision.
    .mockResolvedValueOnce(options(selected, 'Assistant on provider-model-1, chosen again.', REVISION('d')))
  api.accept
    .mockRejectedValueOnce(new ApiRequestError('changed', 409, 'proposal_apply_refused', { error: { metadata: { code: 'proposal_revision_changed' } } }))
    .mockResolvedValueOnce({ result_type: 'gmail_digest', proposal: { id: 'card-1', status: 'accepted' } })
  show()
  const accept = await screen.findByRole('button', { name: 'Accept' })
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  expect(await screen.findByText(/This card changed since it was shown here/)).toBeInTheDocument()
  expect(await screen.findByText('Assistant on provider-model-1, chosen again.')).toBeInTheDocument()
  expect(api.accept).toHaveBeenNthCalledWith(1, 'card-1', expect.objectContaining({ expectedRevision: REVISION('a') }))
  await waitFor(() => expect(accept).toBeEnabled())
  fireEvent.click(accept)
  await waitFor(() => expect(api.accept).toHaveBeenNthCalledWith(2, 'card-1', expect.objectContaining({ expectedRevision: REVISION('d') })))
})
