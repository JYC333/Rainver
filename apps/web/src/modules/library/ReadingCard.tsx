import {useState,type ReactNode} from 'react'
import {Card} from '../../components/ui/card'
import {useAppTranslation} from '../../i18n'

/** Reading and Following share one compact hierarchy; supporting evidence stays accessible.
 * `compact` keeps one line of title and the actions; the summary and details stay one step away. */
export function ReadingCard({title,summary,metadata,topics,details,actions,compact=false,progress}:{
 title:ReactNode;summary:string|null;metadata:ReactNode;topics?:ReactNode;details?:ReactNode;actions:ReactNode
 compact?:boolean
 /** The viewer's own reading progress (private), shown as a thin bar and a label. */
 progress?:{current:number;furthest:number}|null
}){
 const {t}=useAppTranslation()
 const [expanded,setExpanded]=useState(false)
 const read=progress?Math.round(Math.max(progress.current,progress.furthest)*100):0
 return <Card className={`mb-0 min-w-0 ${compact?'px-3 py-2':'p-4'}`}>
  <div className={`flex min-w-0 flex-col sm:flex-row ${compact?'gap-2 sm:items-center sm:gap-4':'gap-3 sm:gap-5'}`}>
   <div className={`min-w-0 flex-1 ${compact?'space-y-1':'space-y-2'}`}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{metadata}{progress&&read>0&&<span>{t('reading.readProgress',{percent:read})}</span>}</div>
    <h2 className={`${compact?'line-clamp-1 text-sm':'line-clamp-2 text-base'} break-words font-semibold leading-snug`}>{title}</h2>
    {progress&&read>0&&<div aria-hidden className="h-0.5 w-full max-w-48 overflow-hidden rounded bg-muted"><div className="h-full bg-primary/60" style={{width:`${read}%`}}/></div>}
    {!compact&&summary&&<p className={`${expanded?'':'line-clamp-2'} whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground`}>{summary}</p>}
    {!compact&&topics&&<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{topics}</div>}
    {(details||summary)&&<details className="text-xs text-muted-foreground" onToggle={event=>setExpanded(event.currentTarget.open)}>
     <summary className="w-fit cursor-pointer hover:text-foreground">{t('reading.details')}</summary>
     <div className="mt-3 space-y-3 border-l-2 border-border pl-3">
      {compact&&summary&&<p className="whitespace-pre-line break-words text-sm leading-relaxed">{summary}</p>}
      {compact&&topics&&<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{topics}</div>}
      {details}
     </div>
    </details>}
   </div>
   <div className={`reading-touch flex shrink-0 flex-wrap items-center justify-end gap-1 ${compact?'sm:flex-row':'sm:w-28 sm:flex-col sm:items-stretch sm:justify-start'} [&_button]:h-auto [&_button]:min-h-7 [&_button]:whitespace-normal [&_a]:h-auto [&_a]:min-h-7 [&_a]:whitespace-normal`}>{actions}</div>
  </div>
 </Card>
}
