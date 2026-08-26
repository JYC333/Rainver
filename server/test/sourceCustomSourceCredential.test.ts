import { randomUUID } from "node:crypto";
import { ONE_ARTICLE_HTML } from "./support/customSourceFixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedCustomSourceWorld, upsertCustomSourceSpacePolicy } from "./support/customSourceWorld.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { CustomSourceCreateFlowService } from "../src/modules/sources/customSources/customSourceCreateFlowService.js";
import { CustomSourceCredentialService } from "../src/modules/sources/customSources/customSourceCredentialService.js";
import { HttpError } from "../src/modules/routeUtils/common.js";

// Real-Postgres integration tests for Phase 10 (Custom Source credentials).
// Skips gracefully when Docker is unavailable.

const SPACE_A = "space-a";
const IDENTITY = { spaceId: SPACE_A, userId: "user-1" };

let config: ServerConfig | undefined;
let createFlow: CustomSourceCreateFlowService | undefined;
let credentialService: CustomSourceCredentialService | undefined;
let artifactStorageRoot: string | undefined;

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["jobs", "retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "policy_decision_records", "proposal_approvals", "proposals", "runs", "space_memberships", "source_handler_runs", "source_handler_versions", "source_recipe_versions", "source_connections", "source_connectors", "scheduler_tasks", "settings", "artifacts", "extraction_jobs", "source_items", "source_snapshots", "extracted_evidence", "credentials", "source_provider_connectors", "source_providers", "users", "spaces"],
    { cascade: true },
  );
  await seedCustomSourceWorld(db.pool, IDENTITY);
  artifactStorageRoot = await mkdtemp(join(tmpdir(), "custom-source-credential-artifacts-"));
  config = {
    ...loadConfig({}),
    databaseUrl: db.connectionUri,
    artifactStorageRoot,
    customSourceAllowedLanguages: ["typescript_node", "declarative_pipeline_v1"],
    rainverHome: artifactStorageRoot,
  };
  createFlow = new CustomSourceCreateFlowService(db.pool, config);
  credentialService = new CustomSourceCredentialService(db.pool, config);
});

afterEach(async () => {
  if (artifactStorageRoot) await rm(artifactStorageRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const FIXTURE_HTML = ONE_ARTICLE_HTML;

describe("CustomSourceCredentialService", () => {
  it("rejects credential creation from a non-admin member", async () => {
    if (!db.available) return;
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ('member-1', 'Member', 'active', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, 'member-1', 'member', 'active', now(), now())`,
      [randomUUID(), SPACE_A],
    );
    await expect(
      credentialService!.create({ spaceId: SPACE_A, userId: "member-1" }, { name: "Feed key", secret: "s3cr3t" }),
    ).rejects.toThrow(HttpError);
  });

  it("create + list never expose the plaintext secret, and resolveCredentialHeader returns the decrypted value with the configured header/prefix", async () => {
    if (!db.available) return;
    const created = await credentialService!.create(IDENTITY, {
      name: "Feed key",
      secret: "s3cr3t-value",
      header_name: "X-Api-Key",
      header_value_prefix: "",
    });
    expect(created).not.toHaveProperty("secret");
    expect(created).not.toHaveProperty("secret_ref");
    expect(JSON.stringify(created)).not.toContain("s3cr3t-value");

    const listed = await credentialService!.list(IDENTITY);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("s3cr3t-value");

    const resolved = await credentialService!.resolveCredentialHeader(SPACE_A, created.id);
    expect(resolved).toEqual({ header_name: "X-Api-Key", header_value: "s3cr3t-value" });

    const dbRow = await db.pool.query<{ secret_ref: string }>(`SELECT secret_ref FROM credentials WHERE id = $1`, [
      created.id,
    ]);
    expect(dbRow.rows[0]?.secret_ref).not.toContain("s3cr3t-value");
    expect(dbRow.rows[0]?.secret_ref).toMatch(/^custom_source_fetch_credential:v1:/);
  });

  it("resolveCredentialHeader returns null for no credential, and requireOwnCredential 404s across spaces", async () => {
    if (!db.available) return;
    expect(await credentialService!.resolveCredentialHeader(SPACE_A, null)).toBeNull();
    expect(await credentialService!.resolveCredentialHeader(SPACE_A, undefined)).toBeNull();

    const created = await credentialService!.create(IDENTITY, { name: "Feed key", secret: "s3cr3t" });
    await expect(
      credentialService!.requireOwnCredential({ spaceId: "space-b", userId: "user-2" }, created.id),
    ).rejects.toThrow(HttpError);
    await expect(credentialService!.requireOwnCredential(IDENTITY, "does-not-exist")).rejects.toThrow(HttpError);
  });
});

describe("Custom Source credentialed handler flow", () => {
  it("carries credential_ref through generateHandler's policy envelope", async () => {
    if (!db.available) return;
    const credential = await credentialService!.create(IDENTITY, { name: "Feed key", secret: "s3cr3t" });
    const connection = await createFlow!.createDraft(IDENTITY, {
      name: "Credentialed Source",
      endpoint_url: "https://example.com/list",
      credential_id: credential.id,
      config: { list_selector: "article" },
    });
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    expect(version.policy_envelope_json).toMatchObject({ credential_ref: credential.id });
  });

  it("testHandler injects the resolved credential header into the live pre-fetch", async () => {
    if (!db.available) return;
    const credential = await credentialService!.create(IDENTITY, {
      name: "Feed key",
      secret: "s3cr3t-value",
      header_name: "Authorization",
      header_value_prefix: "Bearer ",
    });
    const connection = await createFlow!.createDraft(IDENTITY, {
      name: "Credentialed Source",
      endpoint_url: "https://example.com/list",
      credential_id: credential.id,
      config: { list_selector: "article" },
    });
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(FIXTURE_HTML, { status: 200 }));
    const outcome = await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id });
    expect(outcome.run.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalled();
    const requestInit = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(requestInit?.headers).toMatchObject({ Authorization: "Bearer s3cr3t-value" });
  });

  it("first activation with a credential auto-activates when Space policy allows credentialed sources", async () => {
    if (!db.available) return;
    await upsertCustomSourceSpacePolicy(db.pool, SPACE_A, { credentialed_sources_allowed: true });
    const credential = await credentialService!.create(IDENTITY, { name: "Feed key", secret: "s3cr3t" });
    const connection = await createFlow!.createDraft(IDENTITY, {
      name: "Credentialed Source",
      endpoint_url: "https://example.com/list",
      credential_id: credential.id,
      config: { list_selector: "article" },
    });
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(FIXTURE_HTML, { status: 200 }));
    await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id });

    const activation = await createFlow!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id });
    expect(activation.status).toBe("active");
  });

  it("first activation with a credential creates a custom_source_credentialed_source proposal when Space policy disallows it", async () => {
    if (!db.available) return;
    // credentialed_sources_allowed defaults to false — no override needed.
    const credential = await credentialService!.create(IDENTITY, { name: "Feed key", secret: "s3cr3t" });
    const connection = await createFlow!.createDraft(IDENTITY, {
      name: "Credentialed Source",
      endpoint_url: "https://example.com/list",
      credential_id: credential.id,
      config: { list_selector: "article" },
    });
    const version = await createFlow!.generateHandler(IDENTITY, connection.id, {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(FIXTURE_HTML, { status: 200 }));
    await createFlow!.testHandler(IDENTITY, connection.id, { handler_version_id: version.id });

    const activation = await createFlow!.activateHandler(IDENTITY, connection.id, { handler_version_id: version.id });
    expect(activation.status).toBe("pending_approval");
    if (activation.status !== "pending_approval") throw new Error("unreachable");

    const proposalRow = await db.pool.query<{ proposal_type: string }>(`SELECT proposal_type FROM proposals WHERE id = $1`, [
      activation.proposal_id,
    ]);
    expect(proposalRow.rows[0]?.proposal_type).toBe("custom_source_credentialed_source");
  });
});
