import {Select} from '../../../components/ui/select'
import {useAppTranslation} from '../../../i18n'
import {EFFORTS,FREQUENCIES,type Effort,type FollowChoice} from './followOptions'
/** Frequency and effort for one following confirmation (create or confirm). */
export function TopicFollowFields({value,onChange,disabled}:{value:FollowChoice;onChange:(v:FollowChoice)=>void;disabled?:boolean}){
 const {t}=useAppTranslation()
 return <div className="grid gap-4 sm:grid-cols-2">
  <div className="min-w-0 space-y-1.5"><p className="text-sm font-medium">{t('topics.frequency')}</p><Select ariaLabel={t('topics.frequency')} disabled={disabled} value={String(value.interval_seconds)} onChange={v=>onChange({...value,interval_seconds:Number(v)})} options={FREQUENCIES.map(s=>({value:String(s),label:t(`topics.frequencyOption.${s}`)}))}/></div>
  <div className="min-w-0 space-y-1.5"><p className="text-sm font-medium">{t('topics.effort')}</p><Select ariaLabel={t('topics.effort')} disabled={disabled} value={value.effort} onChange={v=>onChange({...value,effort:v as Effort})} options={(Object.keys(EFFORTS) as Effort[]).map(e=>({value:e,label:t(`topics.effortOption.${e}`)}))}/></div>
  <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t('topics.effortNote')}</p>
 </div>
}
