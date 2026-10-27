import { z } from 'zod';
import { ScopedSettingsStore, defineScopedSetting, spaceUserSettingsScopeId } from '../settings/scopedSettings.js';
import { assertProjectReadable, assertProjectReadableLocked } from '../projects/access.js';
import { withQueryableTransaction, type Queryable, type SpaceUserIdentity } from '../routeUtils/common.js';

const PreferencesSchema = z.object({ projects: z.record(z.boolean()).default({}) });
const descriptor = defineScopedSetting({
  key: 'reading.projects', scopeType: 'space_user', defaults: { projects: {} } as z.infer<typeof PreferencesSchema>,
  parse: (value: unknown) => PreferencesSchema.parse(value),
});
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
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`reading-preferences:${scope}`]);
      await new ScopedSettingsStore(tx).update(descriptor, scope, value => ({ projects: { ...value.projects, [projectId]: enabled } }), { updatedByUserId: identity.userId });
      return { show_in_my_reading: enabled };
    });
  }
}
