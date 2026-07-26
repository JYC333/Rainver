import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_ROUTING_MANIFEST,
  invalidContextRoutingManifestEntries,
  mergeContextRoutingManifests,
  normalizeAgentDocPath,
  selectAgentDocPaths,
} from "../src/modules/context/routingManifest";

describe("context routing manifest", () => {
  it("selects default TS module docs", () => {
    const docs = selectAgentDocPaths({
      touchedFiles: ["server/src/modules/context/compiler.ts"],
    });

    expect(docs).toContain(".agent/INDEX.md");
    expect(docs).toContain(".agent/modules/context-compiler.md");
  });

  it("merges default paths and rules in priority order", () => {
    const merged = mergeContextRoutingManifests([
      DEFAULT_CONTEXT_ROUTING_MANIFEST,
      {
        version: 3,
        default_agent_doc_paths: [".agent/custom.md", ".agent/INDEX.md"],
        rules: [
          {
            id: "custom-low",
            path_glob: "packages/protocol/src/**",
            agent_doc_paths: [".agent/modules/client-server-protocol.md"],
            priority: 5,
          },
        ],
      },
    ]);

    expect(merged.version).toBe(3);
    expect(merged.default_agent_doc_paths).toContain(".agent/custom.md");
    expect(merged.default_agent_doc_paths.filter((path) => path === ".agent/INDEX.md")).toHaveLength(1);
    expect(merged.rules[0]).toMatchObject({ id: "custom-low", priority: 5 });
  });

  it("matches glob patterns for path-specific docs", () => {
    const docs = selectAgentDocPaths({
      manifest: {
        version: 1,
        default_agent_doc_paths: [],
        rules: [
          {
            path_glob: "apps/web/src/modules/context_configuration/**",
            agent_doc_paths: [".agent/modules/frontend-layout.md"],
            priority: 1,
          },
        ],
      },
      touchedFiles: ["apps/web/src/modules/context_configuration/ContextConfigurationPage.tsx"],
    });

    expect(docs).toContain(".agent/modules/frontend-layout.md");
  });

  it("rejects unsafe agent doc paths", () => {
    expect(normalizeAgentDocPath("../secret.md")).toBeNull();
    expect(normalizeAgentDocPath("/tmp/secret.md")).toBeNull();
    expect(normalizeAgentDocPath(".agent/../secret.md")).toBeNull();
    expect(normalizeAgentDocPath("docs/README.md")).toBeNull();
    expect(normalizeAgentDocPath(".agent/config.json")).toBeNull();

    const docs = selectAgentDocPaths({
      manifest: {
        version: 1,
        default_agent_doc_paths: ["../secret.md", ".agent/safe.md"],
        rules: [
          {
            path_glob: "server/src/**",
            agent_doc_paths: ["/tmp/secret.md", ".agent/modules/safe.md"],
            priority: 1,
          },
        ],
      },
      touchedFiles: ["server/src/index.ts"],
    });

    expect(docs).toContain(".agent/safe.md");
    expect(docs).toContain(".agent/modules/safe.md");
    expect(docs).not.toContain("../secret.md");
    expect(docs).not.toContain("/tmp/secret.md");
    expect(invalidContextRoutingManifestEntries({
      version: 1,
      default_agent_doc_paths: ["../secret.md"],
      rules: [
        {
          path_glob: "/abs/path",
          agent_doc_paths: ["docs/README.md"],
          priority: 1,
        },
      ],
    })).toEqual([
      "default_agent_doc_paths:../secret.md",
      "rules:/abs/path:path_glob",
      "rules:/abs/path:agent_doc_paths:docs/README.md",
    ]);
  });
});
