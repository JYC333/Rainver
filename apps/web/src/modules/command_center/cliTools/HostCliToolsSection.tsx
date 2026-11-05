import { useEffect, useId, useState } from 'react'
import type { Host } from '../../../types/api'
import { useAppTranslation } from '../../../i18n'
import { Button } from '../../../components/ui/button'
import CliToolsPanel from './CliToolsPanel'
import { hostDisplayName } from '../hostDisplay'

/**
 * A Host's ordinary CLI tools and the person's own account for them.
 * Closed by default, so the Host list's 3 s refresh reads nothing here. Each
 * navigation that names the CLI tools (`openRequest`, that navigation's key)
 * opens it, also within the same Host; a refresh never reopens what the
 * person closed. The Host detail is keyed by Host and this section by nothing
 * that refresh changes, so an open login session survives the refresh;
 * closing the section, or leaving the Host, unmounts the panel, which ends
 * that session.
 */
export default function HostCliToolsSection({ host, openRequest = null }: { host: Host; openRequest?: string | null }) {
  const { t } = useAppTranslation()
  const [open, setOpen] = useState(openRequest !== null)
  useEffect(() => { if (openRequest !== null) setOpen(true) }, [openRequest])
  const regionId = useId()
  const hostName = hostDisplayName(host, t('command_center.builtin_name'))
  const action = open ? t('cli_tools.section_close') : t('cli_tools.section_open')
  return (
    <div className="w-full border-t border-border pt-2 space-y-2" data-testid={`host-cli-tools-${host.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{t('cli_tools.section_title')}</p>
          <p className="text-xs text-muted-foreground">{t('cli_tools.section_hint')}</p>
        </div>
        <Button size="sm" variant={open ? 'ghost' : 'outline'} aria-expanded={open} aria-controls={regionId}
          aria-label={t('cli_tools.section_toggle_label', { action, host: hostName })} onClick={() => setOpen(value => !value)}>
          {action}
        </Button>
      </div>
      {open && (
        <div id={regionId}>
          <CliToolsPanel hostId={host.id} hostKind={host.kind} />
        </div>
      )}
    </div>
  )
}
