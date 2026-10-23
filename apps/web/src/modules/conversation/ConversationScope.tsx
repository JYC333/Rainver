import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LinkProps } from 'react-router-dom'
import type { RequestOptions } from '../../api/client'
import { SpaceLink } from '../../core/spaceNav'
import { spacePath } from '../../core/navigation'

type PanelScope = RequestOptions & { actionUserId?: string; actionRole?: string }
const Scope = createContext<PanelScope>({})

/** Source Space and request lifetime of one mounted conversation/Run panel. */
export function ConversationScope({ spaceId, actionUserId, actionRole, children }: { spaceId?: string; actionUserId?: string; actionRole?: string; children: ReactNode }) {
  const inherited = useContext(Scope)
  return <RequestLifetime key={spaceId ?? inherited.spaceId ?? 'active'} spaceId={spaceId ?? inherited.spaceId} actionUserId={actionUserId ?? inherited.actionUserId} actionRole={actionRole ?? inherited.actionRole}>{children}</RequestLifetime>
}

function RequestLifetime({ spaceId, actionUserId, actionRole, children }: { spaceId?: string; actionUserId?: string; actionRole?: string; children: ReactNode }) {
  const [controller, setController] = useState(() => new AbortController())
  useEffect(() => {
    // StrictMode replay briefly exposes the cleaned-up signal to child effects;
    // replacing the controller reruns them with a live signal (development only).
    if (controller.signal.aborted) setController(new AbortController())
    return () => controller.abort()
  }, [controller])
  const scope = useMemo(() => ({ spaceId, signal: controller.signal, actionUserId, actionRole }), [spaceId, controller, actionUserId, actionRole])
  return <Scope.Provider value={scope}>{children}</Scope.Provider>
}

export const useConversationScope = () => useContext(Scope)

/** Already-scoped destinations pass through SpaceLink without changing URL active Space. */
export function ConversationLink({ to, ...props }: LinkProps) {
  const { spaceId } = useConversationScope()
  return <SpaceLink to={typeof to === 'string' && spaceId ? spacePath(spaceId, to) : to} {...props} />
}
