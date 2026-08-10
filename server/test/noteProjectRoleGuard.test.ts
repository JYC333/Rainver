import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NOTE_PROJECT_ROLES,
  NOTE_PROJECT_ROLE_DEFAULT_TITLES,
} from "../src/modules/knowledge/noteProjectRoles";

/**
 * The guardrail the plan asks for: nothing may resolve a project's baseline
 * note by matching its title.
 *
 * The failure this prevents is specific and was live. `notebookNotes.ts`
 * selected `WHERE so.title = 'Current understanding'`, so renaming that note
 * removed the research comparison's baseline and the comparison degraded
 * silently. A single re-introduced literal is enough to bring the whole defect
 * back, which is why this is a source scan rather than a behaviour test — a
 * behaviour test only covers the call path someone remembered to write one for.
 */

const srcDir = join(__dirname, "..", "src");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const AREA_SERVICE = join("src", "modules", "projectResearch", "areaService.ts");

/**
 * The two methods in `areaService` that may legitimately name a note.
 *
 * `adoptStarterNotesByTitle` reconciles projects seeded before the role marker
 * existed — it reconstructs the binding the old resolver created rather than
 * being a binding of its own, and stops once every role is filled.
 * `resolveProjectNoteByExactTitle` serves the ad-hoc caller that names a note
 * instead of a role: the title there is the user's own input, so matching it is
 * what they asked for, and it creates the note when it finds none.
 */
const ALLOWED_TITLE_METHODS = ["adoptStarterNotesByTitle", "resolveProjectNoteByExactTitle"];

/** Removes the named private methods' bodies from a source file. */
function withoutMethods(source: string, methods: string[]): string {
  let result = source;
  for (const method of methods) {
    const start = result.indexOf(`private async ${method}`);
    expect(start, `${method} has moved or been renamed; update this guard`).toBeGreaterThan(-1);
    const end = result.indexOf("\n  }", start);
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** The module that defines the default titles necessarily contains them. */
const DEFINITION_SITE = join("src", "modules", "knowledge", "noteProjectRoles.ts");

/** Strips `//` and `/* *\/` comments so prose about a title is not a match. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("project note role guardrail", () => {
  it("resolves no project note by its title outside the one-shot adoption", () => {
    const titles = Object.values(NOTE_PROJECT_ROLE_DEFAULT_TITLES);
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const relative = file.slice(join(__dirname, "..").length + 1);
      if (relative === DEFINITION_SITE) continue;
      let source = withoutComments(readFileSync(file, "utf8"));
      if (relative === AREA_SERVICE) source = withoutMethods(source, ALLOWED_TITLE_METHODS);
      for (const title of titles) {
        if (source.includes(`"${title}"`) || source.includes(`'${title}'`) || source.includes(`\`${title}\``)) {
          offenders.push(`${relative}: ${title}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("selects no note by title against a project scope outside the adoption", () => {
    // The literal check above misses the shape the code actually regressed
    // into last time: the title moved into `SECTION_LABELS[key]` and was still
    // passed as a bind parameter to a `so.title = $n` query scoped by
    // `primary_project_id`. That pairing — a project-scoped note query keyed on
    // title — is the defect, whether or not a literal is visible.
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const relative = file.slice(join(__dirname, "..").length + 1);
      let source = withoutComments(readFileSync(file, "utf8"));
      if (relative === AREA_SERVICE) source = withoutMethods(source, ALLOWED_TITLE_METHODS);
      for (const statement of source.split(/`/)) {
        const projectScoped = /primary_project_id\s*=\s*\$/.test(statement);
        const titleKeyed = /\bso\.title\s*=\s*\$/.test(statement) || /\btitle\s*=\s*\$/.test(statement);
        const touchesNotes = /\bFROM\s+notes\b|\bnotes\s+n\b/i.test(statement);
        if (projectScoped && titleKeyed && touchesNotes) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the default titles a creation-time default, never a lookup key", () => {
    // SECTION_LABELS is re-exported widely. What matters is that the only
    // module that turns a role into a *query* keys on `project_role`.
    const notebook = readFileSync(join(srcDir, "modules", "projectResearch", "notebookNotes.ts"), "utf8");
    expect(notebook).toContain("n.project_role");
    expect(notebook).not.toMatch(/so\.title\s*=/);
  });

  it("keeps the server registry and the shared protocol vocabulary identical", async () => {
    // The server list is a deliberate copy (CJS/ESM, synchronous validation on
    // the write path). A copy without a check is how gap 3 happened — the
    // editor's target-kind list drifted from the backend's accepted set with
    // nothing to notice. This is that check.
    const { NOTE_PROJECT_ROLE_VALUES } = await import("@agent-space/protocol");
    expect([...NOTE_PROJECT_ROLES]).toEqual([...NOTE_PROJECT_ROLE_VALUES]);
  });

  it("registers exactly the roles the database format constraint admits", () => {
    // B12F: the column carries a format check, so a role that does not match
    // the shape would be rejected by Postgres rather than by the registry, and
    // the error would name a constraint instead of the vocabulary.
    for (const role of NOTE_PROJECT_ROLES) {
      expect(role).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(NOTE_PROJECT_ROLE_DEFAULT_TITLES[role]).toBeTruthy();
    }
  });
});
