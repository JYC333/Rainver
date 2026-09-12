import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { dropApiCacheAtBoot } from './lib/sessionResidue'
import './index.css'

// `autoUpdate` alone only installs a new service worker; the page already on
// screen keeps running the old bundle until someone reloads, so a deploy
// looked like "nothing changed" until a hard refresh. Registering through the
// virtual module reloads the page once the new worker takes control.
registerSW({ immediate: true })

// Before anything asks who is signed in. The service worker must not cache
// authenticated API bodies and does not — but a cache written by an older
// build, or left behind when a tab closed mid-logout, outlives the code that
// stopped writing it.
dropApiCacheAtBoot()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
