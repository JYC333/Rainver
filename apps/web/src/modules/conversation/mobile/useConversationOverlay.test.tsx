import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { useConversationOverlay } from './useConversationOverlay'

function Fixture() {
  const overlay = useConversationOverlay('projectChat')
  const drawer = useConversationOverlay('conversationDrawer')
  const location = useLocation()
  const navigate = useNavigate()
  return <>
    <output>{location.pathname}{location.search}</output>
    <button onClick={overlay.show}>Open</button>
    <button onClick={() => overlay.close()}>Close</button>
    <button onClick={drawer.show}>Drawer</button>
    <button onClick={() => drawer.close(() => navigate('/selected'))}>Select</button>
    <button onClick={() => drawer.close(() => navigate('/new'))}>New</button>
    <button onClick={() => drawer.close()}>Dismiss</button>
    <button onClick={() => navigate('/project?projectChat=1&detail=1', { state: location.state })}>Copy state</button>
    <button onClick={() => navigate(-1)}>Back</button>
  </>
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`) }))
const at = (path: string) => waitFor(() => expect(screen.getByRole('status').textContent).toBe(path))
describe('owned conversation overlay history', () => {
  it('consumes both owned entries once, including repeated drawer open and close', async () => {
    render(<MemoryRouter initialEntries={['/previous', '/project']} initialIndex={1}><Fixture /></MemoryRouter>)
    click('Open'); await at('/project?projectChat=1')
    click('Drawer'); await at('/project?projectChat=1&conversationDrawer=1')
    click('Dismiss'); await at('/project?projectChat=1')
    click('Drawer'); await at('/project?projectChat=1&conversationDrawer=1')
    click('Back'); await at('/project?projectChat=1')
    click('Close'); await at('/project')
    click('Back'); await at('/previous')
  })
  for (const action of ['Select', 'New']) it(`consumes the drawer before ${action} navigation`, async () => {
    render(<MemoryRouter initialEntries={['/previous', '/project']} initialIndex={1}><Fixture /></MemoryRouter>)
    click('Drawer'); click(action); await at(action === 'Select' ? '/selected' : '/new')
    click('Back'); await at('/project')
    click('Back'); await at('/previous')
  })
  it('does not pop a different entry that copied an overlay marker', async () => {
    render(<MemoryRouter initialEntries={['/previous', '/project']} initialIndex={1}><Fixture /></MemoryRouter>)
    click('Open'); await at('/project?projectChat=1')
    click('Copy state'); await at('/project?projectChat=1&detail=1')
    click('Close'); await at('/project?detail=1')
    click('Back'); await at('/project?projectChat=1')
    click('Close'); await at('/project')
  })
  it('closes a direct deep link in place without leaving the page', async () => {
    render(<MemoryRouter initialEntries={['/outside', '/project?projectChat=1&conversationDrawer=1']} initialIndex={1}><Fixture /></MemoryRouter>)
    click('Dismiss'); await at('/project?projectChat=1')
    click('Close'); await at('/project')
    click('Back'); await at('/outside')
  })
})
