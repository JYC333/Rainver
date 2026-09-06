import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'

// `autoUpdate` alone only installs a new service worker; the page already on
// screen keeps running the old bundle until someone reloads, so a deploy
// looked like "nothing changed" until a hard refresh. Registering through the
// virtual module reloads the page once the new worker takes control.
registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
