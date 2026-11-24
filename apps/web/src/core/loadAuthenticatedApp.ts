// The signed-in app chunk: the Shell, every signed-in route and their strings.
// App's route loads it once someone is signed in. The sign-in form starts it
// early, when the person begins to sign in, so the first signed-in screen
// does not wait for it after the password is accepted.
export const loadAuthenticatedApp = () => import('../AuthenticatedApp')

let started = false

/**
 * Starts the chunk download once. Skipped while the browser reports no
 * network: a browser keeps a failed module import for the document's
 * lifetime, and the route would then show the update panel after sign-in.
 */
export function preloadAuthenticatedApp(): void {
  if (started || (typeof navigator !== 'undefined' && navigator.onLine === false)) return
  started = true
  // A failure here is reported by the route itself if it repeats there.
  loadAuthenticatedApp().catch(() => {})
}
