import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasDeclaration,
  linkTypeDefinition,
  registerLinkType,
  registeredLinkTypes,
} from "../src/modules/ontology/linkTypes.js";
import {
  cardSourceTypes,
  domainStatusSources,
  graphableEntityTypes,
  contextIncludableItemTypes,
  isProvenanceSourceType,
  provenanceSourceTypes,
  registeredEntities,
  resolveContentAccessible,
  retrievableEntityTypes,
} from "../src/modules/ontology/entities.js";
import {
  CONTENT_RESOURCE_TYPES,
  contentResourceDefinitions,
} from "../src/modules/access/contentAccessRegistry.js";
import {
  assertCardSourceType,
  assertContextItemType,
  assertEvidenceableObjectType,
  assertLinkTypeAllowed,
} from "../src/modules/ontology/validation.js";

// B12G: one registry, no parallel per-mechanism type lists. These assertions are
// the mechanism that catches an omission — the previous arrangement had three
// lists at incompatible granularity and nothing that could compare them, which
// is how a relation hint came to be declarable for an edge type
// `object_relations` would reject on write.
describe("ontology registry", () => {
  it("declares every link type in the protocol vocabulary", async () => {
    const { LINK_TYPE_VALUES } = await import("@rainver/protocol");
    const missing = LINK_TYPE_VALUES.filter((value) => !hasDeclaration(value));
    expect(missing).toEqual([]);
  });

  it("does not declare a link type outside the protocol vocabulary", async () => {
    const { LINK_TYPE_VALUES } = await import("@rainver/protocol");
    const known = new Set<string>(LINK_TYPE_VALUES);
    const extra = registeredLinkTypes()
      .map((definition) => definition.linkType)
      .filter((linkType) => !known.has(linkType));
    expect(extra).toEqual([]);
  });

  it("keeps every link type endpoint a registered entity", () => {
    const entities = new Set(registeredEntities().map((entity) => entity.entityType));
    const offenders: string[] = [];
    for (const definition of registeredLinkTypes()) {
      for (const endpoint of [definition.from, definition.to]) {
        if (endpoint === "any") continue;
        for (const entityType of endpoint) {
          if (!entities.has(entityType)) offenders.push(`${definition.linkType}:${entityType}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("preserves the governance the edges had before the registry existed", () => {
    // Thread structure was direct-write as a domain table and must stay direct;
    // routing it through proposals would be a behaviour change, not a refactor.
    const thread = ["inquiry_thread", "inquiry_thread"] as const;
    expect(linkTypeDefinition("decomposes_into", ...thread)?.governance).toBe("direct");
    expect(linkTypeDefinition("proposes", ...thread)?.governance).toBe("direct");
    // The same words between Claims stay reviewed — this is the whole reason
    // governance resolves on endpoints and not on the word alone.
    expect(linkTypeDefinition("contradicts", ...thread)?.governance).toBe("direct");
    expect(linkTypeDefinition("contradicts", "claim", "claim")?.governance).toBe("proposal");
    expect(linkTypeDefinition("supersedes", "knowledge_item", "knowledge_item")?.governance).toBe("proposal");
  });

  it("refuses to resolve an ambiguous link type without endpoints", () => {
    // `contradicts` has both a Thread and a generic declaration; answering
    // without endpoints would make governance depend on registration order.
    expect(linkTypeDefinition("contradicts")).toBeNull();
    expect(linkTypeDefinition("authored_by")).not.toBeNull();
  });

  it("keeps the retrieval object types agreeing with the Retrievable interface", async () => {
    const { RETRIEVAL_OBJECT_TYPE_VALUES } = await import("@rainver/protocol");
    expect([...retrievableEntityTypes()].sort()).toEqual([...RETRIEVAL_OBJECT_TYPE_VALUES].sort());
  });

  it("keeps the SQL retrieval enum agreeing with the Retrievable interface", () => {
    // The consistency test compared the registry with the protocol enum but not
    // with the database's own list, leaving a third copy free to drift.
    const schema = readFileSync(join(import.meta.dirname, "..", "src", "db", "schema", "_types.ts"), "utf8");
    const declared = new RegExp('pgEnum\\("retrieval_object_type", \\[([^\\]]*)\\]').exec(schema)?.[1] ?? "";
    const sqlValues = [...declared.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!).sort();
    expect(sqlValues).toEqual([...retrievableEntityTypes()].sort());
  });

  it("derives the content access registry from ContentAccessible declarations", () => {
    const declared = registeredEntities()
      .filter((entity) => entity.contentAccessible)
      .map((entity) => entity.contentAccessible!.resourceType ?? entity.entityType)
      .sort();
    expect(contentResourceDefinitions().map((d) => d.resourceType).sort()).toEqual(declared);
  });

  it("declares ContentAccessible once for the ontology root, inherited by subtypes", () => {
    // Per-interface granularity: splitting this per object type would fragment
    // a registry the read gate correctly uses at root granularity.
    const root = resolveContentAccessible("space_object");
    expect(root?.tableName).toBe("space_objects");
    for (const subtype of ["knowledge_item", "note", "source", "claim"]) {
      expect(resolveContentAccessible(subtype)?.tableName).toBe("space_objects");
    }
    expect(
      registeredEntities().filter((e) => e.entityType === "knowledge_item")[0]?.contentAccessible,
    ).toBeUndefined();
  });

  // P2.5: the remaining per-mechanism lists. These were three further type
  // universes that nothing reconciled; they converge here because the registry's
  // subject is an Entity, so members that are not `space_objects` rows —
  // activity records, runs, proposals, artifacts, project folders — belong
  // without any of them becoming one.
  it("covers every Runtime Context item type except the inline sentinel", () => {
    const declared = new Set(contextIncludableItemTypes());
    for (const itemType of [
      "memory", "knowledge_item", "source", "activity_record",
      "project_public_summary", "task", "project", "project_folder",
      "run", "proposal", "artifact",
    ]) {
      expect(declared.has(itemType), `${itemType} must be ContextIncludable`).toBe(true);
    }
    // `idea` had no table and no writer; it is not resurrected here.
    expect(declared.has("idea")).toBe(false);
  });

  it("covers every card source type", () => {
    expect([...cardSourceTypes()].sort()).toEqual(
      ["activity", "knowledge_item", "note", "proposal", "run", "source"],
    );
  });

  it("keeps the ontology root's active predicate on the timestamp, not a status column", () => {
    // P1 moved domain status off the root; the gate must not reach for it again.
    expect(resolveContentAccessible("space_object")?.activePredicate?.("so")).toBe("so.deleted_at IS NULL");
  });

  // The demoted CHECKs are only safely demoted if something asks the registry.
  it("rejects values the demoted CHECK constraints used to reject", () => {
    expect(() => assertContextItemType("nonsense")).toThrow();
    expect(() => assertCardSourceType("nonsense")).toThrow();
    expect(() => assertCardSourceType(null)).not.toThrow();
    expect(() => assertEvidenceableObjectType("run")).toThrow();
    expect(() => assertEvidenceableObjectType("source")).not.toThrow();
  });

  it("routes an edge by its declared governance rather than by table", () => {
    // A structural edge proposed for review, or an assertion written directly,
    // is a category error the registry can now catch.
    expect(() => assertLinkTypeAllowed({
      linkType: "decomposes_into", fromObjectType: "inquiry_thread", toObjectType: "inquiry_thread", via: "proposal",
    })).toThrow(/written directly/);
    expect(() => assertLinkTypeAllowed({
      linkType: "contradicts", fromObjectType: "claim", toObjectType: "claim", via: "direct",
    })).toThrow(/through a proposal/);
    expect(() => assertLinkTypeAllowed({
      linkType: "contradicts", fromObjectType: "claim", toObjectType: "claim", via: "proposal",
    })).not.toThrow();
  });

  it("enforces declared endpoints", () => {
    expect(() => assertLinkTypeAllowed({
      linkType: "decomposes_into", fromObjectType: "note", toObjectType: "inquiry_thread", via: "direct",
    })).toThrow(/does not accept note/);
  });

  it("keeps the declared ContentResourceType union matching the registry", () => {
    // The union is restated by hand because the registry is built at runtime;
    // this is what stops the restatement from drifting into a lie.
    expect([...CONTENT_RESOURCE_TYPES].sort())
      .toEqual(contentResourceDefinitions().map((d) => d.resourceType).sort());
  });

  // B12F/B12I claim modules — including plugins — register their own entities.
  // The access list used to be snapshotted at module load, so a plugin
  // registering later was silently invisible. Proving it recomputes does not
  // require registering anything: these registries are module-level singletons,
  // and a test that mutates them leaks into every other file sharing the worker.
  it("recomputes the access list on each read instead of snapshotting it", () => {
    const first = contentResourceDefinitions();
    const second = contentResourceDefinitions();
    expect(first).not.toBe(second);
    expect(first.map((definition) => definition.resourceType))
      .toEqual(second.map((definition) => definition.resourceType));
  });

  it("refuses to let one owner silently take over another's registration", () => {
    // Two declarations that could both match the same edge would make
    // governance depend on registration order. Specific-versus-`any` is
    // allowed; specific-versus-overlapping-specific is not.
    expect(() => registerLinkType({
      linkType: "related_to",
      from: ["inquiry_thread"],
      to: ["inquiry_thread"],
      governance: "proposal",
      retrievalProjected: true,
      owner: "some-plugin",
    })).toThrow(/overlapping declaration/);
    expect(linkTypeDefinition("related_to", "inquiry_thread", "inquiry_thread")?.governance).toBe("direct");
  });

  // Every declared interface must have something that reads it (B12G);
  // otherwise the declaration is documentation wearing a type.
  it("keeps Graphable load-bearing rather than decorative", () => {
    const graphable = graphableEntityTypes();
    expect(graphable).toContain("space_object");
    expect(graphable).toContain("inquiry_thread");
    // Not graphable: it has no node representation, and the graph's lens filter
    // now refuses to widen into a type the registry never declared.
    expect(graphable).not.toContain("run");
  });

  // Polymorphic status SQL is generated from these declarations, and a name
  // that does not resolve does not fail — the LEFT JOIN just yields NULL and
  // the domain quietly drops out of every cross-type query. That is exactly how
  // Threads disappeared from the graph while the status list was hardcoded.
  it("keeps every domain status declaration pointing at a real table column", () => {
    const schemaDir = join(import.meta.dirname, "..", "src", "db", "schema");
    const schema = readdirSync(schemaDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(join(schemaDir, file), "utf8"))
      .join("\n");

    for (const { table, column } of domainStatusSources()) {
      const block = new RegExp(`pgTable\\("${table}",\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema);
      expect(block, `no pgTable declaration for ${table}`).not.toBeNull();
      // Drizzle spells a snake_case column either as an explicit name argument
      // or as a bare camelCase property when the two already agree.
      const camel = column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const declared = block![1]!.includes(`"${column}"`)
        || new RegExp(`\\b${camel}:\\s*\\w+\\(`).test(block![1]!);
      expect(declared, `${table} has no ${column} column`).toBe(true);
    }
  });

  // ND collapsed the provenance vocabulary from four copies to one, but the
  // one it kept was a parallel list rather than an interface declaration, so
  // this test could not see it and two of the copies survived unnoticed. It is
  // a declaration now, which is what puts it in front of these assertions.
  it("declares provenance source types on entities, with no free-floating list", () => {
    const declared = provenanceSourceTypes();
    expect(declared.length).toBeGreaterThan(0);
    expect(new Set(declared).size).toBe(declared.length);
    for (const token of declared) {
      expect(isProvenanceSourceType(token)).toBe(true);
    }
    // Renamed because it lied: it stored a run id under a step's name.
    expect(isProvenanceSourceType("run_step")).toBe(false);
    // Dropped: no writer, no reader, and a run's internal structure is not an
    // entity (B12C).
    expect(isProvenanceSourceType("run_event")).toBe(false);
    expect(isProvenanceSourceType("nonsense")).toBe(false);
    // Kept, for reasons recorded on the declaration: a stored token whose
    // entity is `user`, a value with a live reader, and the one sentinel.
    expect(isProvenanceSourceType("user_confirmation")).toBe(true);
    expect(isProvenanceSourceType("source_snapshot")).toBe(true);
    expect(isProvenanceSourceType("external_source")).toBe(true);
  });

  it("keeps no second copy of the provenance vocabulary in src", () => {
    // The specific failure this prevents: a module keeping its own Set and
    // *silently dropping* what it does not recognize, which is how a
    // divergence lost provenance without an error. Two modules did exactly
    // that until 2026-08-06.
    const srcDir = join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(srcDir);
    const offenders = files.filter((file) => {
      if (file.endsWith(join("ontology", "entities.ts"))) return false;
      return /PROVENANCE_SOURCE_TYPES\s*=/.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  // B12F: subtype vocabulary belongs to the registry. The root table only
  // guards the token shape so adding an extension does not require teaching
  // the ontology root about that domain's type list.
  it("keeps the object_type CHECK open and every registered subtype valid", () => {
    const schema = readFileSync(
      join(import.meta.dirname, "..", "src", "db", "schema", "knowledge.ts"),
      "utf8",
    );
    expect(schema).toContain('check("ck_space_objects_object_type_format"');
    expect(schema).not.toContain('check("ck_space_objects_object_type"');
    const ontologyObjects = registeredEntities()
      .filter((entity) => entity.rootEntity === "space_object")
      .map((entity) => entity.entityType);
    expect(ontologyObjects).toContain("research_workflow");
    expect(ontologyObjects.every((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value))).toBe(true);
  });
});
