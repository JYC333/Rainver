import { useLocation } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { settingsSectionForPath, stripSpacePrefix } from '../../core/navigation'
import { SpaceLink } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { Button } from '../ui/button'
import { hasReadingMethodOrigin } from '../../modules/prompts/paths'

/** Stable parents work after a reload or a direct link, without guessing browser history. */
export function SettingsNavigation() {
  const { pathname, search } = useLocation()
  const { t } = useAppTranslation()
  const section = settingsSectionForPath(pathname)
  if (!section) return null
  if (stripSpacePrefix(pathname) === '/prompts' && hasReadingMethodOrigin(new URLSearchParams(search))) return null
  if (stripSpacePrefix(pathname).replace(/\/$/, '') === section.to) return null
  const label = t(`nav.${section.id.replace(/-/g, '_')}`, { defaultValue: section.label })

  return <nav aria-label={t('shell.settings_navigation')} className="flex flex-wrap items-center gap-2 px-6 pt-4 text-sm">
    <Button asChild size="sm" variant="ghost">
      <SpaceLink to={section.to}><ArrowLeft className="size-4" />{t('shell.back_to', { name: label })}</SpaceLink>
    </Button>
  </nav>
}
