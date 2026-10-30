import { z } from 'zod';
import { ScopedSettingsStore, defineScopedSetting, spaceUserSettingsScopeId } from '../settings/scopedSettings.js';
import { assertProjectReadable, assertProjectReadableLocked } from '../projects/access.js';
import { withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';

const PreferencesSchema = z.object({ projects: z.record(z.boolean()).default({}) });
const descriptor = defineScopedSetting({
  key: 'reading.projects', scopeType: 'space_user', defaults: { projects: {} } as z.infer<typeof PreferencesSchema>,
  parse: (value: unknown) => PreferencesSchema.parse(value),
});
const readingPreferencesLockKey = (identity: SpaceUserIdentity) => `reading-preferences:${spaceUserSettingsScopeId(identity.spaceId, identity.userId)}`;

/**
 * Holds this reader's Reading opt-ins as they are until the transaction ends:
 * the shared side of the lock every change (`ReadingPreferences.set`) takes
 * exclusively. For a holder whose decision rests on which Projects they opted
 * into (a personal briefing reference's model Delivery).
 */
export async function lockReadingPreferencesShared(db: Queryable, identity: SpaceUserIdentity): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [readingPreferencesLockKey(identity)]);
}

export class ReadingPreferences {
  constructor(private readonly db: Queryable) {}
  async enabled(identity: SpaceUserIdentity): Promise<string[]> {
    const { value } = await new ScopedSettingsStore(this.db).get(descriptor, spaceUserSettingsScopeId(identity.spaceId, identity.userId));
    return Object.entries(value.projects).filter(([, enabled]) => enabled).map(([id]) => id);
  }
  async get(identity: SpaceUserIdentity, projectId: string) {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    return { show_in_my_reading: (await this.enabled(identity)).includes(projectId) };
  }
  async set(identity: SpaceUserIdentity, projectId: string, enabled: boolean) {
    return withQueryableTransaction(this.db, async tx => {
      await assertProjectReadableLocked(tx, identity.spaceId, projectId, identity.userId);
      const scope = spaceUserSettingsScopeId(identity.spaceId, identity.userId);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [readingPreferencesLockKey(identity)]);
      await new ScopedSettingsStore(tx).update(descriptor, scope, value => ({ projects: { ...value.projects, [projectId]: enabled } }), { updatedByUserId: identity.userId });
      return { show_in_my_reading: enabled };
    });
  }
}
