import {Button} from '../../../components/ui/button'
import {useAppTranslation} from '../../../i18n'
/** Important updates (default) or every collected matching material. */
export function TopicSelectionToggle({value,onChange}:{value:'important'|'all';onChange:(v:'important'|'all')=>void}){
 const {t}=useAppTranslation()
 return <div role="group" aria-label={t('topics.selectionView')} className="inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
  {(['important','all'] as const).map(option=><Button key={option} size="sm" variant="ghost" aria-pressed={value===option} className={value===option?'bg-background text-foreground shadow-sm hover:bg-background':undefined} onClick={()=>onChange(option)}>{t(`topics.${option}`)}</Button>)}
 </div>
}
