import {useState} from 'react'
import {Button} from '../../components/ui/button'
import {useAppTranslation} from '../../i18n'
type Density='comfortable'|'compact'
const KEY='rainver:reading-density'
export function useReadingDensity(){
 const [value,setValue]=useState<Density>(()=>{try{return localStorage.getItem(KEY)==='compact'?'compact':'comfortable'}catch{return 'comfortable'}})
 const change=(next:Density)=>{setValue(next);try{localStorage.setItem(KEY,next)}catch{/* optional browser preference */}}
 return [value,change] as const
}
export function ReadingDensityControls({value,onChange}:{value:Density;onChange:(v:Density)=>void}){
 const {t}=useAppTranslation()
 return <div role="group" aria-label={t('reading.density')} className="inline-flex rounded-lg bg-muted p-1">{(['comfortable','compact'] as const).map(option=><Button key={option} size="sm" variant="ghost" aria-pressed={value===option} className={value===option?'bg-background text-foreground shadow-sm hover:bg-background':undefined} onClick={()=>onChange(option)}>{t(`reading.density_${option}`)}</Button>)}</div>
}
