import { useAppTranslation } from '../../i18n'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { errMsg } from '../../lib/utils'

export function ReadingError({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useAppTranslation()
  const status = error && typeof error === 'object' && 'status' in error ? error.status : null
  return <Card className="space-y-3 p-4" role="alert"><h2 className="text-sm font-medium">{t(status === 403 || status === 404 ? 'reading.noAccess' : status === 409 ? 'reading.changed' : 'reading.failed')}</h2><p className="break-words text-sm text-muted-foreground">{errMsg(error)}</p><Button size="sm" variant="outline" onClick={retry}>{t('reading.retry')}</Button></Card>
}
