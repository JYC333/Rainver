import { z } from "zod";
import { IdSchema } from "./common.js";

/**
 * Ordinary CLI tools on an execution Host: commands a Run or a person uses
 * directly, as opposed to ACP Agent Runtimes. They never become a RuntimeKey,
 * never enter `installations` and never take part in ACP health checks.
 *
 * The catalog is the one authority for which commands exist, which executable
 * name a registration must resolve to, how a version is read, and the only
 * managed recipes there are. The daemon installs from its own compiled copy of
 * this catalog and refuses a version it does not carry; a request names a tool
 * id and version, never a URL, archive or command.
 */
export const ORDINARY_TOOLS_PROTOCOL = "ordinary-tools-v1";

export const ORDINARY_TOOL_IDS = ["git", "curl", "jq", "rg", "lark_cli"] as const;
export const OrdinaryToolIdSchema = z.enum(ORDINARY_TOOL_IDS);
export type OrdinaryToolId = z.infer<typeof OrdinaryToolIdSchema>;

/** Daemon platform keys (`tools.ts` `platformKey()`), so a recipe and the probe agree. */
export interface OrdinaryToolPlatformArtifact {
  archive: string;
  sha256: string;
  /** Executable path inside the archive; must stay inside the tool directory. */
  cmd: string;
}

export interface OrdinaryToolManagedRecipe {
  version: string;
  /** First-party release the archives and checksums were verified against. */
  release_url: string;
  platforms: Readonly<Record<string, OrdinaryToolPlatformArtifact>>;
}

export interface OrdinaryToolCatalogEntry {
  id: OrdinaryToolId;
  label: string;
  /** The only executable basename a PATH lookup or registration accepts. */
  executable: string;
  /** Fixed argv for reading the version; never a shell string. */
  version_args: readonly string[];
  /** Needs a personal account before use (login itself is a later phase). */
  requires_account: boolean;
  /** Null: Rainver only detects or registers the machine's own copy. */
  managed: OrdinaryToolManagedRecipe | null;
}

const LARK_CLI_VERSION = "1.0.99";
const larkArchive = (platform: string) =>
  `https://github.com/larksuite/cli/releases/download/v${LARK_CLI_VERSION}/lark-cli-${LARK_CLI_VERSION}-${platform}.tar.gz`;

/**
 * Pinned recipes. The lark-cli hashes are the release's `checksums.txt`, which
 * matches the `checksums.txt` inside the npm package `@larksuite/cli@1.0.99`;
 * each archive was downloaded and hashed, and contains `lark-cli` at its root.
 * Windows and riscv64 are not offered: their layouts were not verified.
 */
export const ORDINARY_TOOL_CATALOG: Readonly<Record<OrdinaryToolId, OrdinaryToolCatalogEntry>> = {
  git: { id: "git", label: "Git", executable: "git", version_args: ["--version"], requires_account: false, managed: null },
  curl: { id: "curl", label: "curl", executable: "curl", version_args: ["--version"], requires_account: false, managed: null },
  jq: { id: "jq", label: "jq", executable: "jq", version_args: ["--version"], requires_account: false, managed: null },
  rg: { id: "rg", label: "ripgrep", executable: "rg", version_args: ["--version"], requires_account: false, managed: null },
  lark_cli: {
    id: "lark_cli",
    label: "Feishu / Lark CLI",
    executable: "lark-cli",
    version_args: ["--version"],
    requires_account: true,
    managed: {
      version: LARK_CLI_VERSION,
      release_url: `https://github.com/larksuite/cli/releases/tag/v${LARK_CLI_VERSION}`,
      platforms: {
        "linux-x86_64": { archive: larkArchive("linux-amd64"), sha256: "fd29f51030dde6919b6ca9173bc87852d3846f253d198022ea2d9ee63527b945", cmd: "lark-cli" },
        "linux-aarch64": { archive: larkArchive("linux-arm64"), sha256: "2837145e72922d558538494d0da30ac6c509681fc0791f8818f4ddb87f5125b4", cmd: "lark-cli" },
        "darwin-x86_64": { archive: larkArchive("darwin-amd64"), sha256: "31f900409082728761346a94b7b81038c78b302883b69c36b849b23d843d7de1", cmd: "lark-cli" },
        "darwin-aarch64": { archive: larkArchive("darwin-arm64"), sha256: "f24f4106d1b0b1a4ee9a24ec0953dee6e518476bbe3d9758f78a732477525b21", cmd: "lark-cli" },
      },
    },
  },
};

/** The first dotted release number in a version line (`git version 2.43.0`, `jq-1.7.1`). */
export function ordinaryToolVersion(text: string | null | undefined): string | null {
  return text?.match(/\b(\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Daemon capability report (`capabilities_json.ordinary_tools`)
// ---------------------------------------------------------------------------

export const OrdinaryToolReportSchema = z.object({
  tool_id: OrdinaryToolIdSchema,
  /** `broken`: an executable was resolved but its fixed version command failed. */
  status: z.enum(["available", "missing", "broken"]),
  /** Which copy answered: Rainver's managed one, an owner registration, or PATH. */
  source: z.enum(["managed", "registered", "path"]).nullable(),
  version: z.string().max(100).nullable(),
  version_text: z.string().max(200).nullable(),
  /** The managed copy present, even when it is not the one in use. */
  managed_version: z.string().max(100).nullable(),
  registered: z.boolean(),
  /** The daemon's own catalog carries a recipe for this platform. */
  managed_installable: z.boolean(),
  managed_catalog_version: z.string().max(100).nullable(),
}).strict();
export type OrdinaryToolReport = z.infer<typeof OrdinaryToolReportSchema>;

export const OrdinaryToolsHostReportSchema = z.object({
  protocol: z.literal(ORDINARY_TOOLS_PROTOCOL),
  tools: z.array(OrdinaryToolReportSchema).max(ORDINARY_TOOL_IDS.length),
}).strict();
export type OrdinaryToolsHostReport = z.infer<typeof OrdinaryToolsHostReportSchema>;

// ---------------------------------------------------------------------------
// Wire request/result (carried by `hostWire.ts`)
// ---------------------------------------------------------------------------

/** One operation per frame; the daemon resolves everything else from its catalog. */
export const OrdinaryToolActionSchema = z.discriminatedUnion("action", [
  /** Install or update the managed copy to the catalog's pinned version. */
  z.object({ action: z.literal("install"), tool_id: OrdinaryToolIdSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
  /**
   * Register the machine's own copy. `path` is optional: without it the daemon
   * looks the catalog executable up on its PATH. A given path must be absolute
   * and resolve to a file with the catalog executable's basename.
   */
  z.object({ action: z.literal("register"), tool_id: OrdinaryToolIdSchema, path: z.string().min(1).max(4096).nullable() }).strict(),
  /** Remove the managed copy or the registration; never personal tool state. */
  z.object({ action: z.literal("remove"), tool_id: OrdinaryToolIdSchema, source: z.enum(["managed", "registered"]) }).strict(),
]);
export type OrdinaryToolAction = z.infer<typeof OrdinaryToolActionSchema>;

export const OrdinaryToolResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).nullable(),
  tool: OrdinaryToolReportSchema.nullable(),
});
export type OrdinaryToolResult = z.infer<typeof OrdinaryToolResultSchema>;

// ---------------------------------------------------------------------------
// HTTP DTO (`GET /api/v1/hosts/:hostId/ordinary-tools`)
// ---------------------------------------------------------------------------

export const HostOrdinaryToolSchema = z.object({
  tool_id: OrdinaryToolIdSchema,
  label: z.string(),
  executable: z.string(),
  requires_account: z.boolean(),
  /** `unknown`: the Host has not reported (offline before any report, or update required). */
  host_status: z.enum(["available", "missing", "broken", "unknown"]),
  /** False when the values are the last report of a Host that is now offline. */
  reported_live: z.boolean(),
  source: z.enum(["managed", "registered", "path"]).nullable(),
  version: z.string().nullable(),
  version_text: z.string().nullable(),
  registered: z.boolean(),
  managed: z.object({
    /** The version this control plane would install; null when no recipe exists. */
    catalog_version: z.string().nullable(),
    installed_version: z.string().nullable(),
    installable: z.boolean(),
    update_available: z.boolean(),
  }),
  /** Not established until Run sandbox integration verifies it. */
  sandbox_status: z.literal("not_verified"),
  /** Personal login is not available yet; never reported as signed in. */
  account_status: z.enum(["not_applicable", "not_verified"]),
});
export type HostOrdinaryTool = z.infer<typeof HostOrdinaryToolSchema>;

export const HostOrdinaryToolsResponseSchema = z.object({
  host_id: IdSchema,
  host_state: z.enum(["online", "offline", "update_required"]),
  can_manage: z.boolean(),
  operations: z.array(z.object({ tool_id: OrdinaryToolIdSchema, action: z.enum(["install", "register", "remove"]) })),
  tools: z.array(HostOrdinaryToolSchema),
});
export type HostOrdinaryToolsResponse = z.infer<typeof HostOrdinaryToolsResponseSchema>;
