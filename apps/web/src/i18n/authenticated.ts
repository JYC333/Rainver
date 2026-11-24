import i18n from './index'
import { translationResources } from './resources'

// Imported by the signed-in app before its pages render. A shallow merge: the
// full set already contains every group the sign-in subset holds, so the
// result equals the previous single `init` with all resources.
for (const [locale, translation] of Object.entries(translationResources)) {
  i18n.addResourceBundle(locale, 'translation', translation, false, true)
}
