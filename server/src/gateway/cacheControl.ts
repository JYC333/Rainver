/**
 * What an API response says about being kept.
 *
 * Every `/api/` response is somebody's private content answered against their
 * session cookie. Without an explicit directive a shared proxy, or the
 * browser's own back/forward cache, may keep it and hand it to whoever asks
 * next on that machine — which is the residue logout exists to clear.
 *
 * Its own module because two places need it and neither should import the
 * other: the `onSend` hook in `appShell.ts`, and the SSE streams that hijack
 * the reply and never reach that hook.
 */
export const NO_STORE_CACHE_CONTROL = "no-store, no-cache, must-revalidate, private";
