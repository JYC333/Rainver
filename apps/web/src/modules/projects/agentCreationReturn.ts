/**
 * Creating an Agent from a Project's Agents page or a Room's members returns
 * to that page with the new Agent named, so the person completes the add with
 * one explicit confirmation there. Only a Project Agents or Rooms path in the
 * current Space is accepted; anything else is ignored and the form falls back
 * to the Agent's own page.
 */
const RETURN_PATH = /^\/projects\/[A-Za-z0-9_-]{1,64}\/(agents|rooms)(\?[A-Za-z0-9=&_%.-]*)?$/

export const CREATED_AGENT_PARAM = 'created_agent'

export function agentCreationReturnPath(value: string | null | undefined): string | null {
  if (!value || !RETURN_PATH.test(value)) return null
  return value
}

export function withCreatedAgent(path: string, agentId: string): string {
  const [base, query = ''] = path.split('?', 2) as [string, string?]
  const params = new URLSearchParams(query)
  params.set(CREATED_AGENT_PARAM, agentId)
  return `${base}?${params.toString()}`
}

/** `/agents/new` carrying the Project placement and the way back. */
export function newAgentHref(projectId: string, returnTo: string): string {
  return `/agents/new?${new URLSearchParams({ project: projectId, return_to: returnTo }).toString()}`
}
