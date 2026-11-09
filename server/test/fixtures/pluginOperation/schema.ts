import { pgSchema, text, primaryKey } from 'drizzle-orm/pg-core';
const schema = pgSchema('plugin_operation_probe');
export const records = schema.table('records', {
  spaceId: text('space_id').notNull(),
  userId: text('user_id').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull()
}, t => [primaryKey({
  columns: [t.spaceId, t.userId, t.key]
})]);
