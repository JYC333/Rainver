import type { ReactNode } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useSpace } from '../contexts/SpaceContext'
import { Card, CardTitle } from '../components/ui/card'
import { useAppTranslation } from '../i18n'

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

function canManageSpaceRole(role: string | undefined | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function RequireSpaceAdmin({ children }: { children: ReactNode }) {
  const { spaces, activeSpaceId } = useSpace()
  const { t } = useAppTranslation()
  const role = spaces.find(space => space.id === activeSpaceId)?.role
  if (!canManageSpaceRole(role)) {
    return (
      <RoleRequiredCard
        title={t('core_ui.require_role.space_admin_title')}
        message={t('core_ui.require_role.space_admin_message')}
      />
    )
  }
  return <>{children}</>
}

export function RequireInstanceAdmin({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth()
  const { t } = useAppTranslation()
  if (!currentUser?.is_instance_admin) {
    return (
      <RoleRequiredCard
        title={t('core_ui.require_role.instance_admin_title')}
        message={t('core_ui.require_role.instance_admin_message')}
      />
    )
  }
  return <>{children}</>
}
