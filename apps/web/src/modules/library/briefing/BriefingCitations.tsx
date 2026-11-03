import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Briefing, BriefingEvidence } from '@rainver/protocol'
import { Button } from '../../../components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover'
import { useAppTranslation } from '../../../i18n'

export type CitationSources = {
  evidence: Map<string, BriefingEvidence>
  context: Map<string, Briefing['context'][number]>
  evidenceHref: (evidence: BriefingEvidence) => string
  contextHref?: (key: string) => string
}

/** Presentation only: titles and links come exclusively from the authorized projection. */
function Citation({ sourceKey, sources }: { sourceKey: string; sources: CitationSources }) {
  const { t } = useAppTranslation()
  const item = sources.evidence.get(sourceKey), entry = sources.context.get(sourceKey)
  const title = item?.title || entry?.label
  const [open, setOpen] = useState(false)
  const heading = useId(), panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLAnchorElement>(null), restoringFocus = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  function cancelHover() { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null }
  function cancelClose() { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null }
  function leave() {
    pointerInside.current = false
    cancelHover()
    cancelClose()
    closeTimer.current = setTimeout(() => { if (!panel.current?.contains(document.activeElement)) setOpen(false) }, 150)
  }
  function enter() { pointerInside.current = true; cancelClose() }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])
  if (!title) return null
  const href = item ? sources.evidenceHref(item) : sources.contextHref?.(sourceKey) ?? `#briefing-ref-${sourceKey}`
  return <Popover open={open} onOpenChange={value => { cancelClose(); cancelHover(); setOpen(value) }}>
    <PopoverTrigger asChild>
      <Link ref={trigger} to={href} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 align-baseline text-xs font-normal text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('briefing.citation.inspect', { title })}
        onPointerEnter={event => { if (event.pointerType !== 'touch') { enter(); cancelHover(); hoverTimer.current = setTimeout(() => setOpen(true), 250) } }} onPointerLeave={event => { if (event.pointerType !== 'touch') leave() }}
        onFocus={() => { if (restoringFocus.current) return; cancelClose(); cancelHover(); setOpen(true) }}
        onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node | null)) leave() }}
        onClick={() => { cancelClose(); cancelHover(); setOpen(false) }}>
        <span className="max-w-36 truncate">{title}</span><span className="shrink-0 text-muted-foreground">· {sourceKey.replace(/^S/, '')}</span>
      </Link>
    </PopoverTrigger>
    <PopoverContent aria-labelledby={heading} align="start" className="reading-touch space-y-2"
      ref={panel} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onEscapeKeyDown={event => { event.preventDefault(); cancelClose(); cancelHover(); setOpen(false); restoringFocus.current = true; trigger.current?.focus(); restoringFocus.current = false }}
      onPointerEnter={event => { if (event.pointerType !== 'touch') enter() }} onPointerLeave={event => { if (event.pointerType !== 'touch') leave() }} onFocusCapture={cancelClose}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !pointerInside.current) leave() }}>
      <Link to={href} aria-label={title} className="group block space-y-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span id={heading} className="block break-words font-medium underline-offset-2 group-hover:underline">{title}</span>
        {item?.excerpt && <span className="line-clamp-4 break-words text-sm leading-relaxed text-muted-foreground">{item.excerpt}</span>}
      </Link>
      <p className="break-words text-xs text-muted-foreground">{item ? [item.source_domain, t(`briefing.delta.${item.delta_class}`)].filter(Boolean).join(' · ') : t('briefing.context')}</p>
      {item?.unverified && <p className="text-xs text-warning">{t('briefing.unverified')}</p>}
    </PopoverContent>
  </Popover>
}

export function BriefingRefs({ keys, ...sources }: CitationSources & { keys: string[] }) {
  const { t } = useAppTranslation()
  const [expanded, setExpanded] = useState(false)
  const available = [...new Set(keys)].filter(key => sources.evidence.has(key) || sources.context.has(key))
  const shown = expanded ? available : available.slice(0, 2)
  return <span className="reading-touch text-xs">
    {shown.map(key => <Citation key={key} sourceKey={key} sources={sources}/>)}
    {available.length > 2 && <Button type="button" variant="ghost" size="sm" className="h-auto px-1.5 py-0.5 align-baseline" aria-expanded={expanded} aria-label={expanded ? t('briefing.citation.less') : t('briefing.citation.more', { count: available.length - 2 })} onClick={() => setExpanded(value => !value)}>
      {expanded ? t('briefing.citation.less') : `+${available.length - 2}`}
    </Button>}
  </span>
}

/** Resolve only known reference tokens; never rewrite facts or expose hidden reference metadata. */
export function BriefingText({ text, keys = [], excerpt = false, ...sources }: CitationSources & { text: string; keys?: string[]; excerpt?: boolean }) {
  const parts: ReactNode[] = [], used = new Set<string>()
  const pattern = /\[[SC]\d{1,3}(?:\s*[,，、]\s*[SC]\d{1,3})*\](?:\s*\[[SC]\d{1,3}(?:\s*[,，、]\s*[SC]\d{1,3})*\])*|(?<![\w])[SC]\d{1,3}(?![\w])/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const refs = match[0].match(/[SC]\d{1,3}/g)!
    if (!refs.every(key => sources.evidence.has(key) || sources.context.has(key))) continue
    parts.push(text.slice(start, match.index))
    parts.push(excerpt ? refs.map(key => sources.evidence.get(key)?.title || sources.context.get(key)?.label).join(', ') : <BriefingRefs key={match.index} keys={refs} {...sources}/>);refs.forEach(key => used.add(key))
    start = match.index + match[0].length
  }
  parts.push(text.slice(start))
  const content = parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)
  // Excerpts keep all source controls outside the clamped prose, so keyboard
  // and touch users can inspect every reference even when its sentence is cut.
  if (excerpt) return <><span className="line-clamp-3 break-words">{content}</span><BriefingRefs keys={[...used, ...keys]} {...sources}/></>
  return <>{content} <BriefingRefs keys={keys.filter(key => !used.has(key))} {...sources}/></>
}
