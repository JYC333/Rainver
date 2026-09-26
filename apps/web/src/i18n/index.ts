import i18n from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import { en } from './en'
import { zhCN } from './zh-CN'
import { evolutionEn } from './evolution.en'
import { evolutionZhCN } from './evolution.zh-CN'
import { homeEn } from './home.en'
import { homeZhCN } from './home.zh-CN'
import { mixedSurfacesEn } from './mixedSurfaces.en'
import { mixedSurfacesZhCN } from './mixedSurfaces.zh-CN'
import { publicAuthEn } from './publicAuth.en'
import { publicAuthZhCN } from './publicAuth.zh-CN'

export type Locale = 'en' | 'zh-CN'
export const LOCALE_STORAGE_KEY = 'rainver:locale'

function supportedLocale(value: string | null | undefined): Locale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

function storedLocale(): Locale {
  try { return supportedLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) }
  catch { return 'en' }
}

const initialLocale = storedLocale()

// UI translations belong in the browser. User content and API error codes remain
// server-owned; no locale is sent as authority or persisted in the database.
void i18n.use(initReactI18next).init({
  lng: initialLocale,
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-CN'],
  resources: {
    en: { translation: { ...en, home: homeEn, evolution: evolutionEn, ...mixedSurfacesEn, ...publicAuthEn } },
    'zh-CN': { translation: { ...zhCN, home: homeZhCN, evolution: evolutionZhCN, ...mixedSurfacesZhCN, ...publicAuthZhCN } },
  },
  interpolation: { escapeValue: false }, // React escapes text when it renders.
  initAsync: false,
})

function reflectLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* private mode */ }
}

reflectLocale(initialLocale)
i18n.on('languageChanged', language => reflectLocale(supportedLocale(language)))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === LOCALE_STORAGE_KEY) void i18n.changeLanguage(supportedLocale(event.newValue))
  })
}

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale)
}

export function useAppTranslation() {
  const { t, i18n: instance } = useTranslation()
  return { t, locale: supportedLocale(instance.resolvedLanguage), setLocale }
}

export default i18n
