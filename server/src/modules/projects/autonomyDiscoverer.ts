import { accessibleProjectIds } from "./access.js";
import {
  autonomyDiscovererRegistry,
  type DiscoveredAutonomyCandidate,
} from "../autonomy/registry.js";

export function registerPeriodicDigestAutonomyDiscoverer(): void {
  autonomyDiscovererRegistry.register("periodic_digest", {
    discover: async ({ db, spaceId, ownerUserId, now, config }) => {
      const configuredProjectIds = stringArray(config.project_ids);
      const rows = await db.query<{
        id: string;
        name: string;
        current_focus: string | null;
        updated_at: string;
      }>(
        `SELECT id, name, current_focus, updated_at
           FROM projects
          WHERE space_id = $1
            AND status = 'active'
            AND deleted_at IS NULL
            AND ($2::varchar[] IS NULL OR id = ANY($2::varchar[]))
          ORDER BY id`,
        [spaceId, configuredProjectIds.length ? configuredProjectIds : null],
      );
      const accessible = await accessibleProjectIds(db, spaceId, ownerUserId, rows.rows.map((row) => row.id));
      const day = now.toISOString().slice(0, 10);
      return rows.rows
        .filter((row) => accessible.has(row.id))
        .map((row): DiscoveredAutonomyCandidate => {
          const ageHours = Math.max(0, (now.getTime() - Date.parse(row.updated_at)) / 3_600_000);
          const score = Math.min(10_000, Math.round(ageHours * 100) / 100);
          return {
            kind: "periodic_digest",
            key: `${row.id}:${day}`,
            projectId: row.id,
            durableFactRefs: [{ type: "project", id: row.id, version: row.updated_at }],
            discoverySnapshot: {
              project_id: row.id,
              project_name: row.name,
              current_focus: row.current_focus,
              project_updated_at: row.updated_at,
              digest_window: day,
            },
            rankingScore: score,
            rankingEvidence: {
              algorithm: "oldest_project_update_first",
              project_age_hours: score,
              stable_tiebreak: row.id,
            },
            mayRequireInteractiveAuthorization: false,
          };
        });
    },
    buildLaunch: ({ discoverySnapshot }) => {
      const projectName = stringValue(discoverySnapshot.project_name) ?? "Project";
      return {
        capabilityId: "autonomy.periodic_digest",
        capabilities: [
          "autonomy.periodic_digest",
          "retrieval.preflight_brief",
          "project.summary.brief",
        ],
        prompt: `Create a private periodic progress digest for ${projectName}.`,
        instruction: [
          "Use read-only retrieval and analysis.",
          "Return a concise Markdown report grounded in the supplied Project context.",
          "Do not mutate authoritative state or request interactive authorization.",
        ].join(" "),
      };
    },
    buildReport: ({ now }) => ({
      artifactType: "autonomous_periodic_digest",
      title: `Periodic Project Digest — ${now.toISOString().slice(0, 10)}`,
      fallbackContent: "The autonomous digest completed without a textual summary.",
    }),
  }, "projects");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
