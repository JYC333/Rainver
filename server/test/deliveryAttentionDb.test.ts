import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceMember } from "./support/domainSeeds.js";
import { PgProjectRepository } from "../src/modules/projects/repository.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { ProjectAttentionService } from "../src/modules/projects/attentionService.js";
import { projectAttentionRegistry } from "../src/modules/projects/attentionRegistry.js";
import { registerTasksProjectIntegration } from "../src/modules/tasks/projectIntegration.js";

// The Delivery attention adapter decides whether a person is interrupted at
// all. It runs the same responsibility SQL the Board does; here that SQL is
// exercised against rows the domain's own write paths produced, not rows a
// test wrote by hand — a change to how the chain is consumed shows up here.

const SPACE = "77777777-7777-4777-8777-777777777777";
const OWNER = "7eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER = "7ffffff0-ffff-4fff-8fff-ffffffffffff";

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["tasks", "task_loop_states", "project_work_events", "actors", "space_objects", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Household', 'household', $2, $2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'active', $2, $2)`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'owner', 'active', $4, $4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "member", now });
  registerTasksProjectIntegration();
});

afterEach(() => {
  projectAttentionRegistry.__resetForTests();
});

const owner = { spaceId: SPACE, userId: OWNER };

describe("Delivery attention (real Postgres)", () => {
  it("interrupts the responsible person about a decision, a block, and an overdue Task — and nobody else", async () => {
    if (!db.available) return;
    const project = await new PgProjectRepository(db.pool).create(owner, { name: "Release" });
    const projectId = project.id as string;
    const tasks = new PgTaskRepository(db.pool);
    const create = (title: string, extra: Record<string, unknown> = {}) =>
      tasks.createTask(owner, { project_id: projectId, title, visibility: "space_shared", ...extra });

    // The states the adapter reacts to, reached the way the product reaches
    // them: a status change through the repository, a due date on creation.
    const waiting = await create("Confirm the approach");
    await tasks.updateTask(owner, waiting.id, { status: "waiting_for_review" });
    const blocked = await create("Unblock release");
    await tasks.updateTask(owner, blocked.id, { status: "blocked", blocked_reason: "Waiting for approval" });
    const overdue = await create("Publish release", { due_at: "2020-01-01T00:00:00.000Z", status: "in_progress" });
    // Responsibility resolves through the chain: assigned to someone else,
    // the Task is theirs to be interrupted about, not the owner's.
    const theirs = await create("Write the changelog", { assigned_user_id: OTHER });
    await tasks.updateTask(owner, theirs.id, { status: "waiting_for_review" });
    // Open work with nothing waiting interrupts nobody; neither does work
    // that was called off, however overdue it was.
    await create("Draft the notes", { status: "in_progress" });
    const cancelled = await create("Prepare release", { due_at: "2020-01-01T00:00:00.000Z" });
    await tasks.updateTask(owner, cancelled.id, { status: "cancelled" });

    const attention = new ProjectAttentionService(db.pool);
    const mine = await attention.listAttentionItems(owner, projectId);
    // The service orders by severity and then by time; two items written in
    // the same millisecond tie, so the assertion is on the set.
    expect(mine.map((item) => [item.source_id, item.reason, item.severity]).sort()).toEqual([
      [waiting.id, "waiting_for_review", "high"],
      [blocked.id, "blocked", "high"],
      [overdue.id, "overdue", "normal"],
    ].sort());
    expect(mine.find((item) => item.source_id === blocked.id)).toMatchObject({
      attention_class: "gate",
      area_kind: "delivery",
      summary: "Waiting for approval",
      href: `/tasks/${blocked.id}`,
    });

    // The same Project, read as the other person: only what is theirs.
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, projectId, OTHER],
    );
    const other = await attention.listAttentionItems({ spaceId: SPACE, userId: OTHER }, projectId);
    expect(other.map((item) => item.source_id)).toEqual([theirs.id]);
  });
});
