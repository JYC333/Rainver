import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface ApiErrorDetails {
  code?: string
  message?: string
  host_name?: string
  last_heartbeat_at?: string | null
}

/** Pulls structured server error fields without coupling callers to the API client class. */
export function errBody(e: unknown): ApiErrorDetails | null {
  if (!e || typeof e !== 'object') return null
  const error = e as { code?: unknown; payload?: unknown }
  const payload = error.payload && typeof error.payload === 'object'
    ? error.payload as Record<string, unknown>
    : null
  const code = typeof payload?.code === 'string'
    ? payload.code
    : typeof error.code === 'string' ? error.code : undefined
  const message = typeof payload?.detail === 'string'
    ? payload.detail
    : typeof payload?.message === 'string'
      ? payload.message
      : e instanceof Error ? e.message : undefined
  const hostName = typeof payload?.host_name === 'string' ? payload.host_name : undefined
  const heartbeat = payload && Object.prototype.hasOwnProperty.call(payload, 'last_heartbeat_at')
    ? payload.last_heartbeat_at
    : undefined
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(hostName ? { host_name: hostName } : {}),
    ...(heartbeat === null || typeof heartbeat === 'string' ? { last_heartbeat_at: heartbeat } : {}),
  }
}

export function isNotFoundError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const m = e.message.toLowerCase()
  return m.includes('404') || m.includes('not found') || m.includes('not accessible')
}
