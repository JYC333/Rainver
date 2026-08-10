import { describe, expect, it } from "vitest";
import { contentReadSql } from "../src/modules/access/contentAccessSql";
import { contentResourceDefinitions } from "../src/modules/access/contentAccessRegistry";

/**
 * The share term is on the read gate of every content resource, so what matters
 * as much as it working is it not being *there* for the resources that never
 * declared it. `contentAccessSql` runs on every content read in the system;
 * "equivalent to before" is not the bar — "identical to before" is.
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
    // disjunct it would silently become a grant, which is the one thing U8
    // says sharing must never be.
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
