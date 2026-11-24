import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import App from './App'
import { dropApiCacheAtBoot } from './lib/sessionResidue'
import { finishUpdateAfterReload } from './modules/settings/appVersion'
import './index.css'

// A new worker may wait in the background. Only the explicit update action
// requests activation and reload, so a worker installed by another tab cannot
// reload this one. A tab that reloaded for that action past its unsaved-input
// prompt activates the update now, before it holds any input.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').then(() => finishUpdateAfterReload()).catch(() => {})
}

// Before anything asks who is signed in. The service worker must not cache
// authenticated API bodies and does not. A cache from an older build, or from
// a tab closed mid-logout, can still be there.
dropApiCacheAtBoot()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
