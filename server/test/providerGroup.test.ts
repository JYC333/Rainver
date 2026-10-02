import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { createProviderFromPreset } from "../src/modules/providers/commands/fromPreset.js";
import { providerSupportsTask, resolveProviderCommandStore } from "../src/modules/providers/commands/store.js";
import { effectiveProviderDefault, isProviderEligibleForUser, providerCredentialEligibilitySql } from "../src/modules/providers/eligibility.js";
import { piCatalogForVendor, piCatalogVendorIds, piStructuredToolChoice } from "../src/modules/providers/invocation/piAiChat.js";
import { providerSupportsStructuredOutput } from "../src/modules/providers/structuredOutputCapabilities.js";
import { listProviderVendors, providerVendor } from "../src/modules/providers/vendors.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("providerEligibility", () => {
  const base = {
    provider_enabled: true,
    provider_grant_enabled: true,
    provider_owner_user_id: "owner-1",
    provider_credential_type: "api_key",
    provider_has_eligible_credential: true,
  };

  describe("provider eligibility", () => {
    it("requires a chat-capable provider and an active credential path", () => {
      expect(isProviderEligibleForUser({ ...base, provider_type: "openai" }, "member-1")).toBe(true);
      expect(isProviderEligibleForUser({ ...base, provider_type: "cohere" }, "member-1")).toBe(false);
      expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_has_eligible_credential: false }, "member-1")).toBe(false);
    });

    it("keeps subscription providers owner-scoped while allowing keyless chat vendors", () => {
      expect(isProviderEligibleForUser({
        ...base,
        provider_type: "openai_codex",
        provider_credential_type: "subscription_oauth",
      }, "owner-1")).toBe(true);
      expect(isProviderEligibleForUser({
        ...base,
        provider_type: "openai_codex",
        provider_credential_type: "subscription_oauth",
      }, "member-1")).toBe(false);
      expect(isProviderEligibleForUser({
        ...base,
        provider_type: "ollama",
        provider_credential_type: null,
        provider_has_eligible_credential: false,
      }, "member-1")).toBe(true);
    });

    it("requires active grant and provider state", () => {
      expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_grant_enabled: false }, "member-1")).toBe(false);
      expect(isProviderEligibleForUser({ ...base, provider_type: "openai", provider_enabled: false }, "member-1")).toBe(false);
    });

    it("uses the grant default when present and profile default otherwise", () => {
      expect(effectiveProviderDefault(true, false)).toBe(true);
      expect(effectiveProviderDefault(false, true)).toBe(true);
      expect(effectiveProviderDefault(false, false)).toBe(false);
      expect(effectiveProviderDefault(null, true)).toBe(true);
    });

    it("builds the same pool/primary credential predicate for every SQL caller", () => {
      const sql = providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential");
      expect(sql).toContain("credential.credential_type = 'subscription_oauth'");
      expect(sql).toContain("credential.cooldown_until <= now()");
      expect(sql).toContain("enrolled.credential_id = provider.credential_id");
    });
  });
});

describe("providerTaskAuditDb", () => {
  const SPACE = "72000000-0000-4000-8000-000000000001";
  const USER = "72000000-0000-4000-8000-000000000002";
  const PROVIDER = "72000000-0000-4000-8000-000000000003";


  const db = useTestDatabase(`${import.meta.filename}#providerTaskAuditDb`);

  beforeAll(async () => {
    if (!db.available) return;
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Provider task','personal',now(),now())`, [SPACE]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',now(),now())`,
      [randomUUID(), SPACE, USER],
    );
  });

  describe("Provider task audit persistence", () => {
    it("creates distinct immutable control/delivery/snapshot/Usage refs and closes the snapshot", async () => {
      if (!db.available) return;
      const store = resolveProviderCommandStore({
        databaseUrl: db.connectionUri,
        rainverHome: "/tmp/provider-task-audit-test",
      } as ServerConfig);
      const first = await store.beginProviderTaskAttempt!({
        space_id: SPACE,
        task: "retrieval_synthesis",
        owner_domain: "retrieval",
        provider_id: PROVIDER,
        model: "test-model",
        input_fingerprint: "a".repeat(64),
        metering: {
          space_id: SPACE,
          event_type: "llm.generation",
          source_type: "local_run",
          execution_channel: "managed_api",
          subject_user_id: USER,
        },
      });
      const second = await store.beginProviderTaskAttempt!({
        space_id: SPACE,
        task: "retrieval_synthesis",
        owner_domain: "retrieval",
        provider_id: PROVIDER,
        model: "test-model",
        input_fingerprint: "a".repeat(64),
        metering: {
          space_id: SPACE,
          event_type: "llm.generation",
          source_type: "local_run",
          execution_channel: "managed_api",
          subject_user_id: USER,
        },
      });
      expect(first.delivery_id).not.toBe(second.delivery_id);
      expect(first.invocation_snapshot_id).not.toBe(second.invocation_snapshot_id);
      await store.completeProviderTaskAttempt!(first, { status: "accepted" });
      await store.completeProviderTaskAttempt!(second, { status: "failed", error_code: "provider_timeout" });

      const rows = await db.pool.query<{
        delivery_id: string;
        status: string;
        error_code: string | null;
        control_id: string;
        usage_source_id: string;
      }>(
        `SELECT delivery.id AS delivery_id,snapshot.status,snapshot.error_code,
                delivery.control_id,delivery.usage_source_id
           FROM provider_task_deliveries delivery
           JOIN provider_task_snapshots snapshot ON snapshot.delivery_id=delivery.id
          WHERE delivery.space_id=$1 ORDER BY delivery.created_at,delivery.id`,
        [SPACE],
      );
      expect(rows.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ delivery_id: first.delivery_id, status: "accepted", error_code: null, control_id: first.control_id, usage_source_id: first.usage_source_id }),
        expect.objectContaining({ delivery_id: second.delivery_id, status: "failed", error_code: "provider_timeout", control_id: second.control_id, usage_source_id: second.usage_source_id }),
      ]));
    });
  });
});

describe("providerCommandStoreDb", () => {
  const SPACE = "72000000-0000-4000-8000-000000000011";
  const USER = "72000000-0000-4000-8000-000000000012";
  const db = useTestDatabase(`${import.meta.filename}#providerCommandStoreDb`);
  let rainverHome = "";

  beforeAll(async () => {
    if (!db.available) return;
    rainverHome = await mkdtemp(join(tmpdir(), "provider-command-store-"));
    await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Provider commands','personal',now(),now())`, [SPACE]);
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',now(),now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER]);
    await db.pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',now(),now())`,
      [randomUUID(), SPACE, USER],
    );
  });

  afterAll(async () => {
    if (rainverHome) await rm(rainverHome, { recursive: true, force: true });
  });

  function store() {
    return resolveProviderCommandStore({ databaseUrl: db.connectionUri, rainverHome } as ServerConfig);
  }

  async function createdProviderId(input: Record<string, unknown>): Promise<string> {
    const created = await store().createProvider(SPACE, USER, {
      provider_type: "openai",
      api_key: "sk-test",
      default_model: "gpt-test",
      ...input,
    } as never) as { id: string };
    return created.id;
  }

  async function defaultProviderIds(): Promise<string[]> {
    const rows = await db.pool.query<{ provider_id: string }>(
      `SELECT provider_id FROM model_provider_space_grants WHERE space_id = $1 AND is_default = true`,
      [SPACE],
    );
    return rows.rows.map((row) => row.provider_id);
  }

  it("rejects an invalid embedding dimension before creating the provider", async () => {
    if (!db.available) return;
    // Validation after the first write used to leave a disabled provider and
    // its credential behind, with the Space default cleared and nothing in
    // its place.
    const config = { databaseUrl: db.connectionUri, rainverHome } as ServerConfig;
    await expect(createProviderFromPreset(config, store(), SPACE, USER, {
      preset_id: "cohere_embedding",
      api_key: "sk-test",
      embedding_dimensions: 999,
      is_default: true,
    } as never)).rejects.toThrow(/embedding_dimensions/);

    const rows = await db.pool.query(`SELECT 1 FROM model_providers WHERE space_id = $1 AND provider_type = 'cohere'`, [SPACE]);
    expect(rows.rowCount).toBe(0);
  });

  it("keeps the Space default provider when creating a new default fails", async () => {
    if (!db.available) return;
    const current = await createdProviderId({ name: "Current default", is_default: true });
    expect(await defaultProviderIds()).toEqual([current]);

    await expect(createdProviderId({
      name: "Broken default",
      is_default: true,
      network_profile_id: randomUUID(),
    })).rejects.toThrow(/NetworkProfile/);

    expect(await defaultProviderIds()).toEqual([current]);
    const broken = await db.pool.query(`SELECT 1 FROM model_providers WHERE space_id = $1 AND name = 'Broken default'`, [SPACE]);
    expect(broken.rowCount).toBe(0);
  });

  it("routes to a key marked unhealthy again once its cooldown has passed", async () => {
    if (!db.available) return;
    const providerId = await createdProviderId({ name: "Single key" });
    const eligible = async () => {
      const result = await db.pool.query<{ eligible: boolean }>(
        `SELECT ${providerCredentialEligibilitySql("provider.id", "provider.credential_id", "provider_credential")} AS eligible
           FROM model_providers provider
           LEFT JOIN credentials provider_credential ON provider_credential.id = provider.credential_id
          WHERE provider.id = $1`,
        [providerId],
      );
      return result.rows[0]?.eligible;
    };
    await db.pool.query(
      `UPDATE model_provider_credentials
          SET healthy = false, last_failure_class = 'unauthorized', cooldown_until = now() + interval '1 day'
        WHERE provider_id = $1`,
      [providerId],
    );
    expect(await eligible()).toBe(false);

    await db.pool.query(
      `UPDATE model_provider_credentials SET cooldown_until = now() - interval '1 minute' WHERE provider_id = $1`,
      [providerId],
    );
    expect(await eligible()).toBe(true);
  });
});

describe("providerVendorCapabilities", () => {
  describe("provider vendor capabilities", () => {
    it("uses the vendor registry for OpenAI Codex managed capabilities", () => {
      expect(providerVendor("openai_codex")).toMatchObject({
        supportsChat: true,
        supportsStructuredOutput: true,
      });
      expect(providerSupportsStructuredOutput("openai_codex")).toBe(true);
      expect(piStructuredToolChoice("openai_codex_responses", "structured_output")).toBe("required");
      expect(providerSupportsTask("retrieval_query_rewrite", "openai_codex")).toBe(false);
      expect(providerSupportsTask("retrieval_synthesis", "openai_codex")).toBe(false);
      expect(providerSupportsTask("room_conversation_title", "openai_codex")).toBe(false);
      expect(providerSupportsTask("room_conversation_title", "openai")).toBe(true);
    });

    it("records vendor identity and capability, and nothing about a chat implementation", () => {
      // The registry once carried the pi-ai catalog name each vendor's models are
      // described by. That is a fact about the chat adapter, not about the
      // vendor, and it now lives with the adapter. Nothing implementation-shaped
      // may grow back here: a rate table, a compat flag, or a library-specific
      // model id would make swapping the chat implementation an edit to the
      // server's own vendor vocabulary.
      //
      // What the registry does carry is everything rainver knows about a
      // vendor independently of who talks to it — including the published
      // endpoint and what it can be asked to do, which the web client and the
      // provider-task table used to keep their own copies of.
      for (const vendor of listProviderVendors()) {
        expect(Object.keys(vendor).sort()).toEqual([
          "apiKeyRequired",
          "defaultBaseUrl",
          "displayName",
          "id",
          "protocol",
          "subscriptionOnly",
          "supportsChat",
          "supportsEmbedding",
          "supportsRerank",
          "supportsStructuredOutput",
        ]);
      }
    });

    it("keeps the adapter's catalog map aligned with the vendors it must price", () => {
      // The catalog name used to be a required field on every VendorDescriptor,
      // so adding a vendor without deciding its catalog was a compile error. A
      // map cannot enforce that: an omitted vendor silently resolves to no
      // catalog, pi computes a zero cost from absent rates, and the call is
      // recorded as unpriced with nothing failing. Name the deliberate omissions
      // so a new one has to be added here on purpose.
      const uncatalogued = listProviderVendors()
        .filter((vendor) => piCatalogForVendor(vendor.id) === null)
        .map((vendor) => vendor.id)
        .sort();
      expect(uncatalogued).toEqual([
        // pi-ai does not cover the embedding and rerank vendors at all.
        "cohere",
        // Locally served models: genuinely unpriced here. Whether they cost the
        // operator anything is the router's funding dimension, not this ledger's.
        "ollama",
        // Whatever the operator points it at.
        "openai_compatible",
        "zeroentropy",
      ]);

      // A key naming a vendor that no longer exists is as silent as a missing
      // one, and outlives the vendor it was written for.
      const vendorIds = new Set(listProviderVendors().map((vendor) => vendor.id));
      expect(piCatalogVendorIds().filter((id) => !vendorIds.has(id))).toEqual([]);
    });

    it("fails closed for unknown provider types", () => {
      expect(providerSupportsStructuredOutput("unknown_vendor")).toBe(false);
    });
  });
});
