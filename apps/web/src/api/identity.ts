import { announceSignedOut, becameAnotherAccountHere, finishPendingLogout, hasPendingLogout, noteSignedOut, rememberSignInPending, signOutCount } from '../lib/sessionResidue'
import type {
  AdminAuthUser,
  AuthAccount,
  AuthConfiguration,
  AuthSession,
  BrowserAccountsResponse,
  CurrentUser,
  RegistrationIntentAdmin,
  SpaceInvitationOut,
  SpaceMember,
  SpaceOversightMode,
  SpaceRetrievalSettings,
  SpaceRetrievalSettingsUpdate,
  SpaceSnapshotDefaults,
  SpaceWithMembership,
} from '../types/api'
import { commandReceipt, operationAt } from './operations'
import { ApiRequestError, get, post, SIGNED_OUT_ACCOUNT_HANDLE, setAccountHandle } from './transport'
import type { InstanceInvitationResponse, OperationInput, OperationOutput } from '@rainver/protocol'

// ── Auth / Identity ───────────────────────────────────────────────────────
/**
 * Once the server has signed the browser out it holds no account, and every
 * tab says so (`SIGNED_OUT_ACCOUNT_HANDLE`): a tab that signs in again is not
 * refused as one of the account it left, and one that signs in elsewhere
 * still refuses this tab.
 */
async function sendLogout() {
  const result = await post<null>('/auth/logout', undefined, { signal: AbortSignal.timeout(10_000) })
  setAccountHandle(SIGNED_OUT_ACCOUNT_HANDLE)
  noteSignedOut()
  announceSignedOut()
  return result
}

async function beforeSignIn() {
  try { await finishPendingLogout(sendLogout) }
  catch { throw new ApiRequestError('Previous sign-out is pending', 503, 'logout_pending') }
}

/**
 * A sign-in from a public page selects its account for the whole browser.
 * This tab acts as the new session from its next request. The shared storage
 * of whoever the browser was is cleared, and any other tab still signed in as
 * someone else reloads now rather than keep its streams open until its next
 * request is refused.
 */
async function signedIn<T extends object>(result: Promise<T>): Promise<T> {
  const value = await result
  const handle = (value as { account_handle?: unknown }).account_handle
  if (typeof handle === 'string' && handle) setAccountHandle(handle)
  await becameAnotherAccountHere()
  return value
}
/** The same for a sign-in that leaves for Google: announced once it is back (`AuthContext`). */
function leavingToSignIn(url: string): void {
  rememberSignInPending()
  window.location.href = url
}

export const authApi = {
  me:          ()                  => get<CurrentUser>('/me'),
  mySpaces:    ()                  => get<SpaceWithMembership[]>('/me/spaces'),
  configuration: ()                 => get<AuthConfiguration>('/auth/config'),
  passwordLogin: async (body: { email: string; password: string; rememberMe: boolean }) => {
    await beforeSignIn()
    return signedIn(post<{ user: CurrentUser; account_handle?: string }>('/auth/sign-in/email', body))
  },
  registrationIntent: (body: { email: string; invitation_token?: string }) => post<{ intentId: string; claimSecret: string; authority: string; email: string }>('/auth/registration-intents', body),
  register: async (body: { intent_id: string; claim_secret: string; email: string; password: string; name?: string; remember_me?: boolean }) => {
    await beforeSignIn()
    return signedIn(post<{ ok: boolean; user_id: string; account_handle?: string }>('/auth/register', body))
  },
  registerGoogle: async (body: { intent_id: string; claim_secret: string }) => {
    await beforeSignIn()
    const result = await post<{ url: string }>('/auth/register/google', body)
    rememberSignInPending()
    return result
  },
  completeRegistration: (body: { intent_id: string; claim_secret?: string; name?: string }) => signedIn(post<{ ok: boolean; userId: string }>('/auth/register/complete', body)),
  logout: sendLogout,
  /** The accounts this browser is signed in to; names only, never a session or token. */
  browserAccounts: () => get<BrowserAccountsResponse>('/auth/browser-accounts'),
  switchAccount: (userId: string) => post<{ ok: boolean; account_handle: string }>('/auth/browser-accounts/switch', { user_id: userId }),
  /** Signs in to another existing account beside the current one; a refusal leaves the browser as it was. */
  addPasswordAccount: async (body: { email: string; password: string; rememberMe: boolean }) => {
    await beforeSignIn()
    return post<{ user: CurrentUser }>('/auth/sign-in/email', { ...body, add_account: true })
  },
  /** Leaves for Google; cancelling or failing there returns to `next` still signed in as before. */
  addGoogleAccount: async (next: string) => {
    await beforeSignIn()
    window.location.href = `/api/v1/auth/google?add_account=1&next=${encodeURIComponent(next)}`
  },
  googleLogin: async (next?: string) => {
    await beforeSignIn()
    const url = next
      ? `/api/v1/auth/google?next=${encodeURIComponent(next)}`
      : '/api/v1/auth/google'
    leavingToSignIn(url)
  },
  reauth: (password: string) => post<{ ok: boolean; expires_in: number }>('/auth/reauth', { password }),
  reauthStatus: () => get<{ expires_at: string | null }>('/auth/reauth/status'),
  googleReauth: () => post<{ url: string }>('/auth/reauth/google', {}),
  completeGoogleReauth: () => post<{ ok: boolean; expires_in: number }>('/auth/reauth/google/complete', {}),
  setPassword: (newPassword: string) => post<{ ok: boolean }>('/auth/password/set', { new_password: newPassword }),
  /**
   * Better Auth rotates the session a password change is made from. The tab
   * adopts the rotated session's handle at once, so its own next request is
   * not refused (and the page reloaded) as a tab of another account.
   */
  changePassword: async (body: { current_password: string; new_password: string; revoke_other_sessions?: boolean }) => {
    const signedOutBefore = signOutCount()
    const result = await post<{ ok: boolean; account_handle?: string }>('/auth/password/change', body)
    if (!result.account_handle) return result
    if (signOutCount() !== signedOutBefore || hasPendingLogout()) {
      // Kept as signed out: the tab takes no handle the sign-out ended, and
      // the page that asked sends nothing more as the account it left. The
      // browser is not signed out again — it may hold an account signed in
      // since; the server reads every later request without what this answer
      // wrote back for the session the sign-out revoked
      // (`repairLateSelector`).
      throw new ApiRequestError('This browser signed out while the password was changing', 401, 'signed_out')
    }
    setAccountHandle(result.account_handle)
    return result
  },
  accounts: () => get<AuthAccount[]>('/auth/accounts'),
  sessions: () => get<AuthSession[]>('/auth/sessions'),
  revokeSession: (sessionId: string) => post<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {}),
  revokeOtherSessions: () => post<{ ok: boolean }>('/auth/sessions/revoke-others', {}),
  linkGoogle: () => post<{ url: string }>('/auth/google/link', {}),
  unlinkGoogle: (accountId: string) => post<{ ok: boolean }>('/auth/google/unlink', { account_id: accountId }),
  requestPasswordReset: (email: string) => post<{ ok: boolean }>('/auth/recovery/request', { email }),
  completePasswordReset: (token: string, newPassword: string) => post<{ ok: boolean }>('/auth/recovery/complete', { token, new_password: newPassword }),
  adminInvite: (email: string) => post<InstanceInvitationResponse>('/auth/admin/invitations', { email }),
  adminUsers: () => get<AdminAuthUser[]>('/auth/admin/users'),
  adminDisableUser: (userId: string, key: string = crypto.randomUUID()) => operationAt<OperationOutput<'auth.user.disable'>>('POST', `/auth/admin/users/${encodeURIComponent(userId)}/disable`, {}, key),
  adminEnableUser: (userId: string, key: string = crypto.randomUUID()) => operationAt<OperationOutput<'auth.user.enable'>>('POST', `/auth/admin/users/${encodeURIComponent(userId)}/enable`, {}, key),
  adminResetLink: (userId: string) => post<{ reset_link: string }>(`/auth/admin/users/${encodeURIComponent(userId)}/reset-link`, {}),
  adminRegistrationIntents: () => get<RegistrationIntentAdmin[]>('/auth/admin/registration-intents'),
}

// ── Spaces ────────────────────────────────────────────────────────────────
export const spacesApi = {
  acceptInvitation: async (token: string, idempotencyKey: string = crypto.randomUUID()): Promise<{ space_id: string | null }> =>
    commandReceipt('space.invitation.accept', { token }, idempotencyKey),
  /** Keyed creation; the new Space is read back with the creator's membership. */
  create: async (data: { name: string; type: Exclude<SpaceWithMembership['type'], 'personal'>; oversight_mode?: SpaceOversightMode }, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceWithMembership> => {
    const receipt = await commandReceipt('space.create', data, idempotencyKey)
    return get<SpaceWithMembership>(`/spaces/${encodeURIComponent(receipt.space_id)}`, { spaceId: receipt.space_id })
  },
  get:                  (spaceId: string)                              => get<SpaceWithMembership>(`/spaces/${spaceId}`),
  members:              (spaceId: string)                              => get<SpaceMember[]>(`/spaces/${spaceId}/members`),
  /**
   * The invitation secret is generated here and kept to build the claim link;
   * the server stores only its hash, so a receipt (or a replay) never carries it.
   */
  invite: async (spaceId: string, data: { email: string; role: string }, idempotencyKey: string = crypto.randomUUID(), token: string = invitationSecret()): Promise<SpaceInvitationOut> => {
    const receipt = await commandReceipt('space.invitation.create', { ...data, role: data.role as OperationInput<'space.invitation.create'>['role'], token, space_id: spaceId }, idempotencyKey, { spaceId })
    return { id: receipt.invitation_id, space_id: receipt.space_id, invited_email: receipt.invited_email, role: receipt.role, token, status: receipt.status as SpaceInvitationOut['status'], expires_at: receipt.expires_at }
  },
  getSnapshotDefaults:  (spaceId: string)                              => get<SpaceSnapshotDefaults>(`/spaces/${spaceId}/snapshot-defaults`),
  updateSnapshotDefaults: async (spaceId: string, data: SpaceSnapshotDefaults, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceSnapshotDefaults> => {
    await commandReceipt('space.snapshot_defaults.update', { ...data, space_id: spaceId }, idempotencyKey, { spaceId })
    return spacesApi.getSnapshotDefaults(spaceId)
  },
  getRetrievalSettings: (spaceId: string) =>
    get<SpaceRetrievalSettings>(`/spaces/${spaceId}/retrieval-settings`),
  updateRetrievalSettings: async (spaceId: string, data: SpaceRetrievalSettingsUpdate, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceRetrievalSettings> => {
    await commandReceipt('space.retrieval_settings.update', { ...data, space_id: spaceId }, idempotencyKey, { spaceId })
    return spacesApi.getRetrievalSettings(spaceId)
  },
}

/** 256 random bits, base64url: the Space invitation secret the claim link carries. */
function invitationSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
