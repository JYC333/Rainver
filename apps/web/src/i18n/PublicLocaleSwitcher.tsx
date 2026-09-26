import { useAppTranslation } from './index'

/** Language is available before sign-in, including invitation and password reset. */
export function PublicLocaleSwitcher() {
  const { t, locale, setLocale } = useAppTranslation()
  return (
    <div className="absolute right-4 top-4 flex gap-1" role="group" aria-label={t('settings.language')}>
      <button type="button" onClick={() => setLocale('en')} aria-pressed={locale === 'en'} className="rounded-md border border-border px-2 py-1 text-xs aria-pressed:bg-accent">English</button>
      <button type="button" onClick={() => setLocale('zh-CN')} aria-pressed={locale === 'zh-CN'} className="rounded-md border border-border px-2 py-1 text-xs aria-pressed:bg-accent">简体中文</button>
    </div>
  )
}
