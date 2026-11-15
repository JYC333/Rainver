import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../../../components/ui/button'
import { Textarea } from '../../../components/ui/textarea'
import { useAppTranslation } from '../../../i18n'
import { currentBuild, readLayoutDiagnostics } from '../appVersion'
import { ProbeVersion } from './ProbeVersion'
import { initialTopMode, probeRevision, observationKey, readObservations, topModes, type Verdict } from './topComparison'

type Mode = 'fixed' | 'flow-dvh' | 'flow-vh'
const modes: Mode[] = ['fixed', 'flow-dvh', 'flow-vh']

export function ViewportTest() {
  const { t, locale, setLocale } = useAppTranslation()
  useLayoutEffect(() => {
    const theme = new URLSearchParams(location.search).get('theme')
    if (theme === 'light' || theme === 'dark') document.documentElement.classList.toggle('theme-light', theme === 'light')
  }, [])
  function toggleTheme() {
    const light = document.documentElement.classList.toggle('theme-light')
    const url = new URL(location.href)
    url.searchParams.set('theme', light ? 'light' : 'dark')
    history.replaceState(null, '', url)
  }
  const [mode, setMode] = useState<Mode>(() => { const value = new URLSearchParams(location.search).get('layout'); return modes.find(mode => mode === value) ?? 'flow-vh' })
  const [topMode, setTopMode] = useState(initialTopMode)
  const [observations, setObservations] = useState(readObservations)
  const [storageFailed, setStorageFailed] = useState(false)
  const [samples, setSamples] = useState<object[]>([])
  const [taps, setTaps] = useState(0)
  const [standalone] = useState(() => matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  const editor = useRef<HTMLTextAreaElement>(null)
  const footer = useRef<HTMLElement>(null)
  const sample = useCallback((reason: string) => {
    const rect = footer.current?.getBoundingClientRect()
    const footerBox = rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null
    const header = document.querySelector('.viewport-test-shell > header')
    const headerRect = header?.getBoundingClientRect()
    const active = document.activeElement
    const focusedInputFontSize = active instanceof HTMLTextAreaElement ? getComputedStyle(active).fontSize : null
    setSamples(previous => [...previous.slice(-11), { reason, mode, topMode, probeRevision, observations, inputsHash: currentBuild.inputsHash, taps, at: new Date().toISOString(),
      ...readLayoutDiagnostics(), footer: footerBox,
      header: headerRect ? { top: headerRect.top, bottom: headerRect.bottom, paddingTop: getComputedStyle(header!).paddingTop } : null,
      focusedInputFontSize,
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller) }])
  }, [mode, topMode, observations, taps])

  useEffect(() => {
    sample('layout')
    let timer: ReturnType<typeof setTimeout>
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => sample('viewport'), 250) }
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', changed)
    viewport?.addEventListener('scroll', changed)
    window.addEventListener('resize', changed)
    return () => {
      clearTimeout(timer)
      viewport?.removeEventListener('resize', changed)
      viewport?.removeEventListener('scroll', changed)
      window.removeEventListener('resize', changed)
    }
  }, [sample])

  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('top', topMode)
    url.searchParams.set('layout', mode)
    history.replaceState(null, '', url)
  }, [topMode, mode])
  function observe(verdict: Verdict) {
    const next = { ...observations, [topMode]: { verdict, layout: mode,
      theme: document.documentElement.classList.contains('theme-light') ? 'light' : 'dark', standalone } }
    setObservations(next)
    try {
      sessionStorage.setItem(observationKey, JSON.stringify({ revision: probeRevision, build: currentBuild.id, items: next }))
      setStorageFailed(false)
    } catch { setStorageFailed(true) }
  }

  return <>{(topMode === 'solid' || topMode === 'text-clip') && createPortal(
    <div className="viewport-test-top-surface" data-top={topMode} aria-hidden="true" />, document.body)}<div className="viewport-test-shell app-safe-shell" data-mode={mode} data-top={topMode}>
    <header className="shrink-0 space-y-2 border-b border-border p-3">
      <div className="viewport-test-ruler" aria-hidden="true" />
      <h1 className="text-lg font-semibold">{t('viewport_test.title')}</h1>
      <p className="text-sm font-semibold" data-top-target>{t('viewport_test.top_target')}</p>
      <p className="text-xs">TOP-TEST-2 · {t(`viewport_test.top_${topMode}`)}</p>
    </header>
    <main className="min-h-0 flex-1 space-y-3 overflow-auto overscroll-contain p-3">
      <ProbeVersion />
      <section className="space-y-2" aria-label={t('viewport_test.top_modes')}>
        <h2 className="font-semibold">{t('viewport_test.top_modes')}</h2>
        <p className="text-xs">{t('viewport_test.top_instructions')}</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('viewport_test.top_modes')}>
          {topModes.map(value => <Button key={value} className="min-h-11 h-auto whitespace-normal" variant={topMode === value ? 'default' : 'outline'} aria-pressed={topMode === value}
            onClick={() => { editor.current?.blur(); setTopMode(value) }}>{t(`viewport_test.top_${value}`)}</Button>)}
        </div>
        <p className="text-xs text-muted-foreground">{t('viewport_test.top_caution')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => observe('clear')}>{t('viewport_test.verdict_clear')}</Button>
          <Button variant="outline" onClick={() => observe('blurred')}>{t('viewport_test.verdict_blurred')}</Button>
        </div>
        {storageFailed && <p role="alert" className="text-xs">{t('viewport_test.storage_failed')}</p>}
        <p className="text-xs text-muted-foreground">{t('viewport_test.observation_hint')}</p>
        <ul className="space-y-1 text-xs" aria-label={t('viewport_test.observations')}>
          {topModes.map(value => <li key={value}>{t(`viewport_test.top_${value}`)} · {t(`viewport_test.verdict_${observations[value]?.verdict ?? 'untested'}`)}
            {observations[value] && ` · ${t(`viewport_test.${observations[value]!.layout}`)} / ${observations[value]!.theme} / ${t(observations[value]!.standalone ? 'viewport_test.standalone' : 'viewport_test.browser')}`}</li>)}
        </ul>
      </section>
      <div className="flex gap-2">
        <Button asChild variant="ghost"><a href="/settings">{t('viewport_test.back')}</a></Button>
        <Button variant="ghost" onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>中文 / English</Button>
        <Button variant="ghost" onClick={toggleTheme}>{t('viewport_test.theme')}</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('viewport_test.modes')}>
        {modes.map(value => <Button key={value} className="min-h-11" variant={mode === value ? 'default' : 'outline'} aria-pressed={mode === value}
          onClick={() => { editor.current?.blur(); setMode(value) }}>{t(`viewport_test.${value}`)}</Button>)}
      </div>

      <p className="text-sm">{t('viewport_test.instructions')}</p>
      <p className="text-xs font-medium">{t(standalone ? 'viewport_test.standalone' : 'viewport_test.browser')}</p>
      <p className="text-xs text-muted-foreground">{t('viewport_test.install')}</p>
      <p className="text-xs text-muted-foreground">{t('viewport_test.limit')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => sample('manual')}>{t('viewport_test.record')}</Button>
        <Button variant="ghost" className="min-h-11" onClick={() => editor.current?.blur()}>{t('viewport_test.dismiss')}</Button>
      </div>
      <p role="status" className="text-xs">{t('viewport_test.status', { count: samples.length, taps })}</p>
      <details>
        <summary className="cursor-pointer text-sm">{t('viewport_test.results')}</summary>
        <Textarea readOnly className="mt-2 h-56 font-mono" aria-label={t('viewport_test.results')}
          value={JSON.stringify(samples, null, 2)} onFocus={event => event.target.select()} />
      </details>
    </main>
    <footer ref={footer} className="viewport-test-footer shrink-0 border-t border-border bg-card">
      <div className="space-y-2 p-3">
        <Textarea ref={editor} className="min-h-11 resize-none" rows={1} aria-label={t('viewport_test.editor')} placeholder={t('viewport_test.editor')} onFocus={() => sample('focus')} />
        <Button className="min-h-11 w-full" onClick={() => setTaps(value => value + 1)}>{t('viewport_test.tap', { count: taps })}</Button>
      </div>
      <div className="viewport-test-edge bg-primary text-center text-xs text-primary-foreground">{t('viewport_test.edge')}</div>
    </footer>
  </div></>
}
