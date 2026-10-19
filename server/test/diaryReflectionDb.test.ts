import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";

interface DiaryRuntime {
  diaryPlugin: { migrations?: Array<{ id: string; sql: string }> };
  diaryRepository: {
    upsertEntry(db: unknown, input: { userId: string; entryDate: string; content: string }): Promise<{ id: string }>;
    saveReflection(db: unknown, entryId: string, reflectionDate: string, content: string, aiModel?: string): Promise<{ id: string; content: string }>;
    findReflectionsForEntry(db: unknown, entryId: string): Promise<Array<{ id: string; content: string; ai_model: string | null }>>;
  };
}

function loadDiaryRuntime(): DiaryRuntime {
  const requireRuntime = createRequire(import.meta.filename);
  return {
    diaryPlugin: (requireRuntime("../dist/official-plugins/diary/server/index.js") as { diaryPlugin: DiaryRuntime["diaryPlugin"] }).diaryPlugin,
    diaryRepository: (requireRuntime("../dist/official-plugins/diary/server/domain/repository.js") as { diaryRepository: DiaryRuntime["diaryRepository"] }).diaryRepository,
  };
}

const { diaryPlugin, diaryRepository } = loadDiaryRuntime();

const db = useTestDatabase(import.meta.filename, { max: 12, empty: true });

beforeAll(async () => {
  if (!db.available) return;
  for (const migration of diaryPlugin.migrations!) {
    await db.pool.query(migration.sql);
  }
});

describe("diary reflection writer", () => {
  it("declares one reflection per entry and day in the schema", async () => {
    const constraint = await db.pool.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'diary_reflections'::regclass AND contype = 'u'`,
    );
    expect(constraint.rows.map((row) => row.conname)).toEqual(["diary_reflections_entry_date_unique"]);
    await expect(db.pool.query(
      `INSERT INTO diary_reflections (entry_id, reflection_date, content)
       SELECT id, '2026-06-19', 'one' FROM diary_entries LIMIT 0`,
    )).resolves.toBeDefined();
  });

  it("lands one durable reflection however many workers write the same entry and day at once", async () => {
    const entry = await diaryRepository.upsertEntry(db.pool, { userId: "user-diary-1", entryDate: "2026-06-19", content: "Today" });
    const writers = Array.from({ length: 10 }, (_, index) =>
      diaryRepository.saveReflection(db.pool, entry.id, "2026-06-19", `reflection ${index}`, "stub"));
    const saved = await Promise.all(writers);
    expect(new Set(saved.map((row) => row.id)).size).toBe(1);
    const reflections = await diaryRepository.findReflectionsForEntry(db.pool, entry.id);
    expect(reflections).toHaveLength(1);
    expect(saved.map((row) => row.content)).toContain(reflections[0]!.content);

    // A later day is a second reflection, not a replacement of the first.
    await diaryRepository.saveReflection(db.pool, entry.id, "2026-06-20", "next day", "stub");
    expect(await diaryRepository.findReflectionsForEntry(db.pool, entry.id)).toHaveLength(2);
  });
});
