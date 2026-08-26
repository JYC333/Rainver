import type { Queryable } from "@agent-space/protocol";

export interface DiaryEntryRow {
  id: string;
  user_id: string;
  entry_date: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface DiaryReflectionRow {
  id: string;
  entry_id: string;
  reflection_date: string;
  content: string;
  ai_model: string | null;
  created_at: string;
}

export interface UpsertEntryInput {
  userId: string;
  entryDate: string;
  content: string;
}

export const diaryRepository = {
  async findEntry(db: Queryable, userId: string, date: string): Promise<DiaryEntryRow | null> {
    const result = await db.query<DiaryEntryRow>(
      `SELECT id, user_id, entry_date::text, content, created_at::text, updated_at::text
         FROM diary_entries
        WHERE user_id = $1 AND entry_date = $2::date`,
      [userId, date],
    );
    return result.rows[0] ?? null;
  },

  async upsertEntry(db: Queryable, input: UpsertEntryInput): Promise<DiaryEntryRow> {
    const result = await db.query<DiaryEntryRow>(
      `INSERT INTO diary_entries (user_id, entry_date, content)
       VALUES ($1, $2::date, $3)
       ON CONFLICT (user_id, entry_date) DO UPDATE
         SET content = EXCLUDED.content,
             updated_at = now()
       RETURNING id, user_id, entry_date::text, content, created_at::text, updated_at::text`,
      [input.userId, input.entryDate, input.content],
    );
    return result.rows[0]!;
  },

  async deleteEntry(db: Queryable, userId: string, date: string): Promise<boolean> {
    const result = await db.query(
      `DELETE FROM diary_entries WHERE user_id = $1 AND entry_date = $2::date`,
      [userId, date],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async findOnThisDay(db: Queryable, userId: string, date: string): Promise<DiaryEntryRow[]> {
    const result = await db.query<DiaryEntryRow>(
      `SELECT id, user_id, entry_date::text, content, created_at::text, updated_at::text
         FROM diary_entries
        WHERE user_id = $1
          AND EXTRACT(MONTH FROM entry_date) = EXTRACT(MONTH FROM $2::date)
          AND EXTRACT(DAY FROM entry_date) = EXTRACT(DAY FROM $2::date)
        ORDER BY entry_date DESC`,
      [userId, date],
    );
    return result.rows;
  },

  async listEntries(
    db: Queryable,
    userId: string,
    limit = 30,
    before?: string,
  ): Promise<DiaryEntryRow[]> {
    if (before) {
      const result = await db.query<DiaryEntryRow>(
        `SELECT id, user_id, entry_date::text, content, created_at::text, updated_at::text
           FROM diary_entries
          WHERE user_id = $1 AND entry_date < $2::date
          ORDER BY entry_date DESC
          LIMIT $3`,
        [userId, before, limit],
      );
      return result.rows;
    }
    const result = await db.query<DiaryEntryRow>(
      `SELECT id, user_id, entry_date::text, content, created_at::text, updated_at::text
         FROM diary_entries
        WHERE user_id = $1
        ORDER BY entry_date DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows;
  },

  async findReflectionsForEntry(db: Queryable, entryId: string): Promise<DiaryReflectionRow[]> {
    const result = await db.query<DiaryReflectionRow>(
      `SELECT id, entry_id, reflection_date::text, content, ai_model, created_at::text
         FROM diary_reflections
        WHERE entry_id = $1
        ORDER BY reflection_date DESC`,
      [entryId],
    );
    return result.rows;
  },

  async insertReflection(
    db: Queryable,
    entryId: string,
    reflectionDate: string,
    content: string,
    aiModel?: string,
  ): Promise<DiaryReflectionRow> {
    const result = await db.query<DiaryReflectionRow>(
      `INSERT INTO diary_reflections (entry_id, reflection_date, content, ai_model)
       VALUES ($1, $2::date, $3, $4)
       RETURNING id, entry_id, reflection_date::text, content, ai_model, created_at::text`,
      [entryId, reflectionDate, content, aiModel ?? null],
    );
    return result.rows[0]!;
  },

  async isAiReflectionEnabled(
    db: Queryable,
    pluginId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await db.query<{ enabled: boolean; settings_json: Record<string, unknown> }>(
      `SELECT enabled, settings_json
         FROM official_plugin_enablements
        WHERE plugin_id = $1
          AND enabled = true
          AND space_id IS NULL
          AND user_id = $2
        LIMIT 1`,
      [pluginId, userId],
    );
    const row = result.rows[0];
    return row?.enabled === true && row.settings_json["ai_reflection_enabled"] === true;
  },

  async findEnabledUserIds(db: Queryable, pluginId: string): Promise<string[]> {
    const result = await db.query<{ user_id: string }>(
      `SELECT user_id
         FROM official_plugin_enablements
        WHERE plugin_id = $1
          AND enabled = true
          AND space_id IS NULL
          AND user_id IS NOT NULL`,
      [pluginId],
    );
    return result.rows.map((r) => r.user_id);
  },
};
