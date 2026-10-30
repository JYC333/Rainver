import { customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService.js";
import { SourceProviderCatalogService } from "../src/modules/sources/catalog/sourceProviderCatalogService.js";
import { seedCustomSourceWorld } from "./support/customSourceWorld.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { fetchCustomSourceEndpointHtml } from "../src/modules/sources/customSources/customSourceEndpointFetch.js";
import { publicAddressGuard } from "./support/outboundGuard.js";

describe("sourceCustomSourceEndpointFetch", () => {
  const ORIGIN = "https://sources.example";

  const POLICY_ENVELOPE = customSourcePolicyEnvelope({ allowed_network_origins: [ORIGIN] });

  

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchCustomSourceEndpointHtml", () => {
    it("fetches and follows same-origin redirects allowed by the handler envelope", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (String(url) === `${ORIGIN}/redirect-same-origin`) {
          return new Response(null, { status: 302, headers: { location: "/ok" } });
        }
        return new Response("hello pi world", { status: 200 });
      });

      const html = await fetchCustomSourceEndpointHtml(`${ORIGIN}/redirect-same-origin`, runnerSettings(), POLICY_ENVELOPE, null, publicAddressGuard);
      expect(html).toBe("hello pi world");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${ORIGIN}/ok`);
    });

    it("rejects an off-origin redirect before following it", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://other.example/off-origin" } }),
      );

      await expect(
        fetchCustomSourceEndpointHtml(`${ORIGIN}/redirect-off-origin`, runnerSettings(), POLICY_ENVELOPE, null, publicAddressGuard),
      ).rejects.toThrow("not allowed by the handler policy envelope");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("truncates fetched HTML by UTF-8 byte length", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello pi world", { status: 200 }));

      const html = await fetchCustomSourceEndpointHtml(
        `${ORIGIN}/ok`,
        runnerSettings({ download_bytes_max: 8 }),
        { ...POLICY_ENVELOPE, limits: { ...POLICY_ENVELOPE.limits, max_download_bytes: 8 } },
        null,
        publicAddressGuard,
      );
      expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(8);
      expect(html).toBe("hello pi");
    });
  });
});

describe("sourceChannelTargetConnection", () => {
  const db = useTestDatabase(`${import.meta.filename}#sourceChannelTargetConnection`);
  const identity = { spaceId: "space-channel-target", userId: "user-channel-target" };

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(db.pool, ["users", "spaces", "source_connectors", "source_providers"], { cascade: true });
    await seedCustomSourceWorld(db.pool, identity);
  });

  function feed(service: SourceChannelService, sourceName: string, url: string, extra: Record<string, unknown> = {}) {
    return service.create(identity, {
      provider_key: "custom_source", source_name: sourceName, name: `${sourceName} feed`,
      query: {}, endpoint_url: url, fetch_frequency: "manual", ...extra,
    }) as Promise<{ id: string; source_connection_id: string }>;
  }

  it("adds a monitor to the Source it names, not to the provider's most recently updated one", async () => {
    if (!db.available) return;
    const service = new SourceChannelService(db.pool, loadConfig({}));
    const first = await feed(service, "Source A", "https://a.example/feed.xml", { _force_create: true });
    const second = await feed(service, "Source B", "https://b.example/feed.xml", { _force_create: true });
    await db.pool.query(`UPDATE source_connections SET updated_at = now() + interval '1 hour' WHERE id = $1`, [first.source_connection_id]);

    const added = await feed(service, "Source B", "https://b.example/other.xml", { source_connection_id: second.source_connection_id });

    expect(added.source_connection_id).toBe(second.source_connection_id);
  });

  it("refuses a Source that is not the caller's", async () => {
    if (!db.available) return;
    const service = new SourceChannelService(db.pool, loadConfig({}));
    await expect(feed(service, "Nowhere", "https://c.example/feed.xml", { source_connection_id: "connection-of-someone-else" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("serves catalog connectors and providers in the protocol's shape, on list and on update", async () => {
    if (!db.available) return;
    const catalog = new SourceProviderCatalogService(db.pool);
    const listed = await catalog.listCatalog();
    expect(listed.connectors.length).toBeGreaterThan(0);
    for (const connector of listed.connectors) {
      expect(connector).toMatchObject({ capabilities: expect.any(Object) });
      expect(connector).toHaveProperty("config_schema");
      expect(connector).not.toHaveProperty("capabilities_json");
    }
    const connector = listed.connectors[0]!;
    expect(await catalog.updateConnector(connector.id, { status: "disabled" }))
      .toMatchObject({ id: connector.id, status: "disabled", capabilities: connector.capabilities });
    const provider = listed.providers[0]!;
    const updated = await catalog.updateProvider(provider.id, { status: "disabled" });
    expect(updated).toMatchObject({ id: provider.id, status: "disabled", capabilities: provider.capabilities, connector_mapping: provider.connector_mapping });
    expect(updated).not.toHaveProperty("capabilities_json");
  });
});
