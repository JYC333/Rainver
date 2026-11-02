import {useAppTranslation} from '../../../i18n'
import {errMsg} from '../../../lib/utils'
import {Button} from '../../../components/ui/button'
export function ReadingFeedback({error,loading,retry}:{error?:unknown;loading?:boolean;retry?:()=>void}){
 const {t}=useAppTranslation();return <>{error!=null&&<div role="alert" className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm"><p>{errMsg(error)}</p>{retry&&<Button variant="outline" size="sm" onClick={retry}>{t('reading.retry')}</Button>}</div>}{loading&&<p role="status" className="text-sm text-muted-foreground">{t('reading.loadingVersions')}</p>}</>
}
