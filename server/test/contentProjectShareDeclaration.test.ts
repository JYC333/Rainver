import { describe, expect, it } from "vitest";
import { contentReadSql } from "../src/modules/access/contentAccessSql.js";
import { contentResourceDefinitions } from "../src/modules/access/contentAccessRegistry.js";

/**
 * The share term is on the read gate of every content resource that declares
 * one, and absent from every resource that does not. Do not emit the term as
 * false, and do not add it to a resource that never declared a share. The
 * predicate would change.
 */
describe("additional project scope declaration", () => {
  it("emits the share term only for the resource that declares one", () => {
    const declaring = contentResourceDefinitions().filter((definition) => definition.projectShare);
    expect(declaring.map((definition) => definition.resourceType)).toEqual(["space_object"]);

    const sql = contentReadSql("space_object", "so", "$1");
    expect(sql).toContain("space_object_project_shares");
  });

  it("leaves every other resource's predicate free of the term, not merely false", () => {
    for (const definition of contentResourceDefinitions()) {
      if (definition.projectShare) continue;
      const sql = contentReadSql(definition.resourceType, "res", "$1");
      expect(sql, `${definition.resourceType} names the share table`).not.toContain("space_object_project_shares");
      expect(sql, `${definition.resourceType} carries an empty share branch`).not.toContain("content_share");
    }
  });

  it("keeps the share strictly inside the project-scope conjunct", () => {
    // A share widens *scope*. If the term ever escaped into the visibility
    // disjunct it would silently become a grant, which sharing must never be.
    const sql = contentReadSql("space_object", "so", "$1");
    const shareIndex = sql.indexOf("space_object_project_shares");
    const visibilityIndex = sql.indexOf("so.visibility IN ('private', 'space_shared', 'selected_users')");
    expect(shareIndex).toBeGreaterThan(-1);
    expect(visibilityIndex).toBeGreaterThan(-1);
    expect(shareIndex).toBeLessThan(visibilityIndex);
  });

  it("rejects a declaration whose identifiers are not identifiers", () => {
    // The registry composes the SQL and callers pass only names; this is the
    // check that keeps it that way (B12G).
    const definition = contentResourceDefinitions().find((entry) => entry.projectShare);
    expect(definition).toBeTruthy();
    for (const key of ["tableName", "resourceColumn", "projectColumn", "revokedColumn"] as const) {
      expect(definition!.projectShare![key]).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});
