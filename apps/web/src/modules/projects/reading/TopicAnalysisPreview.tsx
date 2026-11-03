import type {Briefing,BriefingEvidence} from '@rainver/protocol'
import {useAppTranslation} from '../../../i18n'
import {BriefingText} from '../../library/briefing/BriefingCitations'

/** A bounded excerpt of the authorized result, never another model summary. */
export function TopicAnalysisPreview({briefing,evidenceHref,reportHref}:{briefing:Briefing;evidenceHref:(e:BriefingEvidence)=>string;reportHref:string}){
 const {t}=useAppTranslation()
 const evidence=new Map(briefing.evidence.map(e=>[e.key,e])),context=new Map(briefing.context.map(c=>[c.key,c]))
 const highlights=briefing.highlights.slice(0,2)
 const text=(value:string,keys:string[]=[],excerpt=false)=> <BriefingText text={value} keys={keys} excerpt={excerpt} evidence={evidence} context={context} evidenceHref={evidenceHref} contextHref={key=>`${reportHref}#briefing-ref-${key}`}/>
 return <div className="space-y-4 text-sm leading-relaxed">
  {briefing.topic?.summary&&<p className="break-words">{text(briefing.topic.summary,[],true)}</p>}
  {briefing.visibility==='partial'&&<p className="text-xs text-muted-foreground">{t('briefing.partial',{count:briefing.hidden_units})}</p>}
  {briefing.context_outdated&&<p className="text-xs text-muted-foreground">{t('briefing.context_outdated')}</p>}
  <ul className="space-y-3">{highlights.map(h=><li key={h.index} className="space-y-1">
   <p className="font-medium break-words">{text(h.title)}</p>
   <p className="break-words">{text(h.what_changed,h.refs,true)}</p>
  </li>)}</ul>
  {highlights.some(h=>h.rests_on_unverified||h.refs.some(key=>evidence.get(key)?.unverified))&&<p className="text-xs text-muted-foreground">{t('briefing.unverified')}</p>}
 </div>
}
