import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import type { ServerConfig } from "../../config.js";
import { withTransaction } from "../../db/tx.js";
import { seedSpaceDefaults } from "../spaces/spaceSeeds.js";
import { hashOpaqueToken, normalizeAuthEmail } from "./securityPolicy.js";

export type RegistrationAuthority = "bootstrap" | "space_invitation";
export interface RegistrationIntentResult { intentId: string; claimSecret: string; authority: RegistrationAuthority; email: string; invitationId: string | null }
export interface RegistrationCompletion { userId: string; intentId: string; authority: RegistrationAuthority }

type RegistrationClient = {
  query<T = unknown>(text: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

type PendingUser = { id: string; status: string };
type Invitation = {
  id: string;
  invited_email: string;
  status: string;
  expires_at: Date | string;
  reserved_by_intent_id: string | null;
};
type ResumableIntent = {
  id: string;
  authority: RegistrationAuthority;
  invitation_id: string | null;
  pending_user_id: string | null;
};

const ACTIVE_INTENT_STATES = "('issued', 'claimed', 'provisioning')";

export class RegistrationService {
  constructor(private readonly pool: Pool, private readonly config: ServerConfig) {}

  async isBootstrapAvailable(): Promise<boolean> {
    if (!this.config.instanceAdminEmail) return false;
    const email = normalizeAuthEmail(this.config.instanceAdminEmail);
    const users = await this.pool.query<{ total: number; pending_admin: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'pending' AND email = $1)::int AS pending_admin
         FROM users`,
      [email],
    );
    const total = Number(users.rows[0]?.total ?? 0);
    const pendingAdmin = Number(users.rows[0]?.pending_admin ?? 0);
    return total === 0 || (total === 1 && pendingAdmin === 1);
  }

  async issueIntent(input: { email: string; invitationToken?: string }): Promise<RegistrationIntentResult> {
    const email = normalizeAuthEmail(input.email);
    const claimSecret = randomBytes(32).toString("base64url");
    const claimHash = hashOpaqueToken(claimSecret);

    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rainver-registration-admission'))");
      await expireStaleIntents(client, new Date());

      const users = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM users");
      const existingResult = await client.query<PendingUser>(
        "SELECT id, status FROM users WHERE email = $1 FOR UPDATE",
        [email],
      );
      const existingUser = existingResult.rows[0] ?? null;
      const invitationToken = input.invitationToken?.trim();

      let authority: RegistrationAuthority;
      let invitationId: string | null = null;

      const bootstrapResume = Number(users.rows[0]?.count ?? 0) === 1
        && existingUser?.status === "pending"
        && Boolean(this.config.instanceAdminEmail)
        && normalizeAuthEmail(this.config.instanceAdminEmail!) === email;

      if (Number(users.rows[0]?.count ?? 0) === 0 || bootstrapResume) {
        if (!this.config.instanceAdminEmail || normalizeAuthEmail(this.config.instanceAdminEmail) !== email) {
          throw new Error("registration_not_authorized");
        }
        if (invitationToken) throw new Error("registration_not_authorized");
        authority = "bootstrap";

        const resumed = await rotateResumableIntent(client, {
          email,
          authority,
          invitationId: null,
          pendingUserId: existingUser?.id ?? null,
          allowUnbound: true,
          claimHash,
        });
        if (resumed) return { intentId: resumed.id, claimSecret, authority, email, invitationId: null };
      } else {
        if (!invitationToken) throw new Error("registration_invitation_required");
        const invitationResult = await client.query<Invitation>(
          `SELECT id, invited_email, status, expires_at, reserved_by_intent_id
             FROM space_invitations
            WHERE token_hash = $1
            FOR UPDATE`,
          [hashOpaqueToken(invitationToken)],
        );
        const invitation = invitationResult.rows[0];
        if (!invitation || normalizeAuthEmail(invitation.invited_email) !== email || new Date(invitation.expires_at).getTime() <= Date.now()) {
          throw new Error("registration_invitation_invalid");
        }

        authority = "space_invitation";
        invitationId = invitation.id;

        if (invitation.status === "reserved" && invitation.reserved_by_intent_id) {
          const resumed = await rotateResumableIntent(client, {
            email,
            authority,
            invitationId,
            intentId: invitation.reserved_by_intent_id,
            pendingUserId: existingUser?.status === "pending" ? existingUser.id : null,
            claimHash,
          });
          if (resumed) return { intentId: resumed.id, claimSecret, authority, email, invitationId };
        }
        if (invitation.status !== "available") throw new Error("registration_invitation_invalid");
        if (existingUser && existingUser.status !== "pending") throw new Error("registration_not_authorized");
      }

      const pendingUserId = existingUser?.status === "pending" ? existingUser.id : null;
      if (pendingUserId) await retireActiveIntents(client, pendingUserId);

      const intentId = randomUUID();
      await client.query(
        `INSERT INTO registration_intents
          (id, claim_secret_hash, email, authority, invitation_id, state,
           pending_user_id, created_at, last_activity_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'issued', $6, now(), now(), now() + interval '30 minutes')`,
        [intentId, claimHash, email, authority, invitationId, pendingUserId],
      );
      if (invitationId) {
        const reserved = await client.query(
          `UPDATE space_invitations
              SET status = 'reserved', reserved_by_intent_id = $1, reserved_at = now()
            WHERE id = $2 AND status = 'available'
            RETURNING id`,
          [intentId, invitationId],
        );
        if (!reserved.rowCount) throw new Error("registration_invitation_invalid");
      }
      return { intentId, claimSecret, authority, email, invitationId };
    });
  }

  async sessionUserId(sessionToken: string | undefined): Promise<string | null> {
    if (!sessionToken) return null;
    const result = await this.pool.query<{ user_id: string; expires_at: Date | string }>(
      "SELECT user_id, expires_at FROM user_sessions WHERE token_hash = $1 LIMIT 1",
      [hashOpaqueToken(sessionToken.split(".", 1)[0]!)],
    );
    const row = result.rows[0];
    return row && new Date(row.expires_at).getTime() > Date.now() ? row.user_id : null;
  }

  async complete(input: { intentId: string; claimSecret: string; userId: string; displayName?: string }): Promise<RegistrationCompletion> {
    const claimHash = hashOpaqueToken(input.claimSecret);
    await this.pool.query(
      `UPDATE registration_intents
          SET pending_user_id = COALESCE(pending_user_id, $3),
              state = 'provisioning',
              last_activity_at = now()
        WHERE id = $1
          AND claim_secret_hash = $2
          AND state IN ('issued', 'claimed', 'provisioning')
          AND expires_at > now()
          AND EXISTS (
            SELECT 1 FROM users candidate
             WHERE candidate.id = $3
               AND candidate.email = registration_intents.email
               AND candidate.status = 'pending'
          )`,
      [input.intentId, claimHash, input.userId],
    );
    return withTransaction(this.pool, async (client) => {
      const intentResult = await client.query<{ id: string; email: string; authority: RegistrationAuthority; invitation_id: string | null; state: string; pending_user_id: string | null; expires_at: Date | string }>(
        "SELECT id, email, authority, invitation_id, state, pending_user_id, expires_at FROM registration_intents WHERE id = $1 AND claim_secret_hash = $2 FOR UPDATE",
        [input.intentId, claimHash],
      );
      const intent = intentResult.rows[0];
      if (!intent || new Date(intent.expires_at).getTime() <= Date.now() || intent.state === "expired") throw new Error("registration_intent_invalid");
      if (intent.state === "completed") return { userId: intent.pending_user_id ?? input.userId, intentId: intent.id, authority: intent.authority };
      if (intent.pending_user_id && intent.pending_user_id !== input.userId) throw new Error("registration_intent_invalid");
      const user = await client.query<{ id: string; email: string; status: string }>("SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
      if (!user.rows[0] || normalizeAuthEmail(user.rows[0].email) !== intent.email || user.rows[0].status === "disabled") throw new Error("registration_intent_invalid");
      await client.query("UPDATE registration_intents SET pending_user_id = $1, state = 'provisioning', last_activity_at = now() WHERE id = $2", [input.userId, intent.id]);
      if (input.displayName?.trim()) await client.query("UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2", [input.displayName.trim(), input.userId]);
      const personal = await client.query<{ id: string }>("SELECT s.id FROM spaces s JOIN space_memberships m ON m.space_id = s.id WHERE m.user_id = $1 AND s.type = 'personal' AND m.status = 'active' ORDER BY m.created_at ASC LIMIT 1", [input.userId]);
      if (!personal.rows[0]) {
        const spaceId = randomUUID();
        const name = input.displayName?.trim() || intent.email.split("@", 1)[0]!;
        await client.query("INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'personal', $3, now(), now())", [spaceId, `${name}'s Personal Space`, input.userId]);
        await client.query("INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', now(), now())", [randomUUID(), spaceId, input.userId]);
        await seedSpaceDefaults(client, spaceId, input.userId);
      }
      if (intent.invitation_id) {
        const invitation = await client.query<{ space_id: string; role: string; status: string; reserved_by_intent_id: string | null }>("SELECT space_id, role, status, reserved_by_intent_id FROM space_invitations WHERE id = $1 FOR UPDATE", [intent.invitation_id]);
        const row = invitation.rows[0];
        if (!row || row.status !== "reserved" || row.reserved_by_intent_id !== intent.id) throw new Error("registration_invitation_invalid");
        await client.query(
          `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', now(), now())
           ON CONFLICT (space_id, user_id)
           DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()`,
          [randomUUID(), row.space_id, input.userId, row.role],
        );
        await client.query("UPDATE space_invitations SET status = 'accepted', accepted_at = now() WHERE id = $1", [intent.invitation_id]);
      }
      await client.query("UPDATE users SET status = 'active', registration_source = $1, updated_at = now() WHERE id = $2", [intent.authority === "space_invitation" ? "space_invitation" : "bootstrap", input.userId]);
      await client.query("UPDATE registration_intents SET state = 'completed', completed_at = now(), last_activity_at = now() WHERE id = $1", [intent.id]);
      return { userId: input.userId, intentId: intent.id, authority: intent.authority };
    });
  }

  async reapStale(now = new Date()): Promise<number> {
    return withTransaction(this.pool, (client) => expireStaleIntents(client, now));
  }
}

async function rotateResumableIntent(
  client: RegistrationClient,
  input: {
    email: string;
    authority: RegistrationAuthority;
    invitationId: string | null;
    intentId?: string;
    pendingUserId: string | null;
    allowUnbound?: boolean;
    claimHash: string;
  },
): Promise<ResumableIntent | null> {
  const values: unknown[] = [input.email, input.authority, input.invitationId];
  let idClause = "";
  if (input.intentId) {
    values.push(input.intentId);
    idClause = ` AND id = $${values.length}`;
  } else if (input.pendingUserId) {
    values.push(input.pendingUserId);
    idClause = ` AND (pending_user_id = $${values.length} OR pending_user_id IS NULL)`;
  } else if (input.allowUnbound) {
    idClause = " AND pending_user_id IS NULL";
  } else {
    return null;
  }
  const result = await client.query<ResumableIntent>(
    `SELECT id, authority, invitation_id, pending_user_id
       FROM registration_intents
      WHERE email = $1
        AND authority = $2
        AND invitation_id IS NOT DISTINCT FROM $3
        AND state IN ${ACTIVE_INTENT_STATES}
        AND expires_at > now()
        ${idClause}
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE`,
    values,
  );
  const intent = result.rows[0];
  if (!intent) return null;
  await client.query(
    `UPDATE registration_intents
        SET claim_secret_hash = $1,
            pending_user_id = COALESCE(pending_user_id, $2),
            last_activity_at = now(),
            expires_at = now() + interval '30 minutes'
      WHERE id = $3`,
    [input.claimHash, input.pendingUserId, intent.id],
  );
  return { ...intent, pending_user_id: intent.pending_user_id ?? input.pendingUserId };
}

async function retireActiveIntents(client: RegistrationClient, pendingUserId: string): Promise<void> {
  const retired = await client.query<{ id: string }>(
    `UPDATE registration_intents
        SET state = 'expired', pending_user_id = NULL, last_activity_at = now()
      WHERE pending_user_id = $1
        AND state IN ${ACTIVE_INTENT_STATES}
      RETURNING id`,
    [pendingUserId],
  );
  if (retired.rows.length) {
    await client.query(
      `UPDATE space_invitations
          SET status = 'available', reserved_by_intent_id = NULL, reserved_at = NULL
        WHERE reserved_by_intent_id = ANY($1::text[])`,
      [retired.rows.map((row) => row.id)],
    );
  }
}

async function expireStaleIntents(client: RegistrationClient, now: Date): Promise<number> {
  const expired = await client.query<{ id: string; pending_user_id: string | null }>(
    `UPDATE registration_intents
        SET state = 'expired', last_activity_at = $1
      WHERE state IN ${ACTIVE_INTENT_STATES}
        AND expires_at <= $1
      RETURNING id, pending_user_id`,
    [now],
  );
  if (!expired.rows.length) return 0;

  const intentIds = expired.rows.map((row) => row.id);
  await client.query(
    `UPDATE space_invitations
        SET status = 'available', reserved_by_intent_id = NULL, reserved_at = NULL
      WHERE reserved_by_intent_id = ANY($1::text[])`,
    [intentIds],
  );

  const pendingUserIds = [...new Set(expired.rows.flatMap((row) => row.pending_user_id ? [row.pending_user_id] : []))];
  if (pendingUserIds.length) {
    await client.query(
      "UPDATE registration_intents SET pending_user_id = NULL WHERE id = ANY($1::text[])",
      [intentIds],
    );
    const disposableUsers = await client.query<{ id: string }>(
      `SELECT u.id
         FROM users u
        WHERE u.id = ANY($1::text[])
          AND u.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
              FROM registration_intents active
             WHERE active.pending_user_id = u.id
               AND active.state IN ${ACTIVE_INTENT_STATES}
          )
        FOR UPDATE`,
      [pendingUserIds],
    );
    const userIds = disposableUsers.rows.map((row) => row.id);
    if (userIds.length) {
      await client.query("DELETE FROM user_sessions WHERE user_id = ANY($1::text[])", [userIds]);
      await client.query("DELETE FROM auth_accounts WHERE user_id = ANY($1::text[])", [userIds]);
      await client.query("DELETE FROM users WHERE id = ANY($1::text[]) AND status = 'pending'", [userIds]);
    }
  }
  return expired.rowCount ?? 0;
}
