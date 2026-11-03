import {ChevronLeft,ChevronRight} from 'lucide-react'
import {Button} from '../../../components/ui/button'
import {DatePicker} from '../../../components/ui/date-picker'
import {useAppTranslation} from '../../../i18n'
import {shiftDigestDate} from '../../library/DigestDay'
export function EditionDateNav({date,today,timezone,onChange}:{date:string;today?:string;timezone?:string;onChange:(day:string)=>void}){
 const {t}=useAppTranslation()
 return <div className="flex min-w-0 flex-wrap items-center gap-1">
  <Button size="sm" variant="ghost" disabled={!date} aria-label={t('digest_reports.previous_day')} onClick={()=>onChange(shiftDigestDate(date,-1))}><ChevronLeft className="size-4"/></Button>
  <DatePicker value={date} max={today} onChange={onChange} ariaLabel={t('projectReading.editionDate')}/>
  <Button size="sm" variant="ghost" disabled={!date||!today||date>=today} aria-label={t('digest_reports.next_day')} onClick={()=>onChange(shiftDigestDate(date,1))}><ChevronRight className="size-4"/></Button>
  {today&&<Button size="sm" variant="ghost" disabled={date===today} onClick={()=>onChange(today)}>{t('projectReading.today')}</Button>}
  {timezone&&<span className="text-xs text-muted-foreground">{timezone}</span>}
 </div>
}
