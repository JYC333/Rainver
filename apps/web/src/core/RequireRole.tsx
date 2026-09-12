import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSpace } from '../contexts/SpaceContext'
import { Card, CardTitle } from '../components/ui/card'

function RoleRequiredCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="p-6 max-w-4xl">
      <Card>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-3.5" /> {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{message}</p>
      </Card>
    </div>
  )
}

export function canManageSpaceRole(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function RequireSpaceAdmin({ children }: { children: ReactNode }) {
  const { spaces, activeSpaceId } = useSpace()
  const role = spaces.find(space => space.id === activeSpaceId)?.role
  if (!canManageSpaceRole(role)) {
    return (
      <RoleRequiredCard
        title="Space admin required"
        message="Only a space owner or admin can open this page."
      />
    )
  }
  return <>{children}</>
}

export function RequireInstanceAdmin({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth()
  if (!currentUser?.is_instance_admin) {
    return (
      <RoleRequiredCard
        title="Instance admin required"
        message="Only the configured instance admin can open this page."
      />
    )
  }
  return <>{children}</>
}
