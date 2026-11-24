import { finishPendingLogout } from '../lib/sessionResidue'
import type {
  AdminAuthUser,
  AuthAccount,
  AuthConfiguration,
  AuthSession,
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
import { ApiRequestError, get, post } from './transport'
import type { InstanceInvitationResponse, OperationInput, OperationOutput } from '@rainver/protocol'

// ── Auth / Identity ───────────────────────────────────────────────────────
function sendLogout() {
  return post<null>('/auth/logout', undefined, { signal: AbortSignal.timeout(10_000) })
}

async function beforeSignIn() {
  try { await finishPendingLogout(sendLogout) }
  catch { throw new ApiRequestError('Previous sign-out is pending', 503, 'logout_pending') }
}

export const authApi = {
  me:          ()                  => get<CurrentUser>('/me'),
  mySpaces:    ()                  => get<SpaceWithMembership[]>('/me/spaces'),
  configuration: ()                 => get<AuthConfiguration>('/auth/config'),
  passwordLogin: async (body: { email: string; password: string; rememberMe: boolean }) => {
    await beforeSignIn()
    return post<{ user: CurrentUser }>('/auth/sign-in/email', body)
  },
  registrationIntent: (body: { email: string; invitation_token?: string }) => post<{ intentId: string; claimSecret: string; authority: string; email: string }>('/auth/registration-intents', body),
  register: async (body: { intent_id: string; claim_secret: string; email: string; password: string; name?: string; remember_me?: boolean }) => {
    await beforeSignIn()
    return post<{ ok: boolean; user_id: string }>('/auth/register', body)
  },
  registerGoogle: async (body: { intent_id: string; claim_secret: string }) => {
    await beforeSignIn()
    return post<{ url: string }>('/auth/register/google', body)
  },
  completeRegistration: (body: { intent_id: string; claim_secret?: string; name?: string }) => post<{ ok: boolean; userId: string }>('/auth/register/complete', body),
  logout: sendLogout,
  googleLogin: async (next?: string) => {
    await beforeSignIn()
    const url = next
      ? `/api/v1/auth/google?next=${encodeURIComponent(next)}`
      : '/api/v1/auth/google'
    window.location.href = url
  },
  reauth: (password: string) => post<{ ok: boolean; expires_in: number }>('/auth/reauth', { password }),
  reauthStatus: () => get<{ expires_at: string | null }>('/auth/reauth/status'),
  googleReauth: () => post<{ url: string }>('/auth/reauth/google', {}),
  completeGoogleReauth: () => post<{ ok: boolean; expires_in: number }>('/auth/reauth/google/complete', {}),
  setPassword: (newPassword: string) => post<{ ok: boolean }>('/auth/password/set', { new_password: newPassword }),
  changePassword: (body: { current_password: string; new_password: string; revoke_other_sessions?: boolean }) => post<{ ok: boolean }>('/auth/password/change', body),
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
