import {useLayoutEffect,useRef} from 'react'

/** Only this mounted Overview owns its return position. No content or position
 * survives a scope/session remount; Shell and Project keep their own scrollers. */
export function useAnalysisFocus(selected:string|null){
 const root=useRef<HTMLElement>(null)
 const saved=useRef<{trigger:HTMLElement;scroll:Array<{element:HTMLElement;top:number;left:number}>}|null>(null)
 const previous=useRef(selected)
 function remember(trigger:HTMLElement){
  const scroll=[]
  for(let element=root.current?.parentElement;element;element=element.parentElement){
   if(/auto|scroll/.test(getComputedStyle(element).overflowY))scroll.push({element,top:element.scrollTop,left:element.scrollLeft})
  }
  saved.current={trigger,scroll}
 }
 useLayoutEffect(()=>{
  if(selected){
   const heading=root.current?.querySelector<HTMLElement>('[data-analysis-heading]')
   heading?.focus({preventScroll:true});heading?.scrollIntoView?.({block:'start'})
  }else if(previous.current&&saved.current){
   saved.current.trigger.focus({preventScroll:true})
   for(const {element,top,left} of saved.current.scroll){element.scrollTop=top;element.scrollLeft=left}
   saved.current=null
  }else if(previous.current){
   const topic=document.getElementById(`theme-${previous.current}`)
   topic?.focus({preventScroll:true});topic?.scrollIntoView?.({block:'start'})
  }
  previous.current=selected
 },[selected])
 return {root,remember}
}
