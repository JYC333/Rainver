import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RainverPlugin } from "@rainver/protocol";
import { BUILT_IN_PLUGINS } from "../../src/modules/plugins/builtInPlugins.js";

/** The frozen published migration of the retired `applications` package, byte for byte. */
export const RETIRED_APPLICATIONS_MIGRATION = {
  id: "0000_applications_and_mail_facts",
  sql: readFileSync(fileURLToPath(new URL("../../../plugins/retired/applications/migrations/0000_applications_and_mail_facts.sql", import.meta.url)), "utf8"),
};

/**
 * The `applications` 1.0.0 release as an old image bundled it, rebuilt from the
 * renamed package: the same runtime and schemas under the old ID, operation
 * namespace, entry titles and frozen migration. Only test fixtures install it.
 */
export function retiredApplicationsRelease(): RainverPlugin {
  const current = BUILT_IN_PLUGINS.find(({ id }) => id === "phd_application")!;
  const m = current.operationManifest!;
  const old = (id: string) => id.replace(/^plugin\.phd_application\./, "plugin.applications.");
  return {
    ...current,
    id: "applications",
    migrations: [RETIRED_APPLICATIONS_MIGRATION],
    operationManifest: {
      ...m,
      id: "applications",
      name: "Application management",
      migrations: [RETIRED_APPLICATIONS_MIGRATION.id],
      operations: m.operations.map((o) => ({ ...o, id: old(o.id), ...(o.proposal_type ? { proposal_type: old(o.proposal_type) } : {}) })),
      proposalTypes: m.proposalTypes?.map((t) => ({ ...t, id: old(t.id), operation: old(t.operation) })),
      web: m.web && { ...m.web, entries: m.web.entries.map((e) => ({ ...e, title: "Applications" })) },
    },
  };
}
