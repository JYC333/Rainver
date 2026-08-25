import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { buildModuleServer } from "./support/moduleServer";
import { crossSpaceRetrievalModule } from "../src/modules/crossSpaceRetrieval";
import { __setAuthIdentityForTests } from "../src/modules/auth";
import { __setCrossSpaceRetrievalServiceFactoryForTests } from "../src/modules/crossSpaceRetrieval/routes";
import {
  PERSONAL_AGGREGATED_RESOURCE_TYPES,
  personalAggregatedRetrievalRegistry,
} from "../src/modules/crossSpaceRetrieval/service";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const POINTER_A = "33333333-3333-4333-8333-333333333333";
const POINTER_B = "44444444-4444-4444-8444-444444444444";
const DISCLOSURE = "55555555-5555-4555-8555-555555555555";
const ARTIFACT = "66666666-6666-4666-8666-666666666666";
const EGRESS_A = "77777777-7777-4777-8777-777777777777";
const EGRESS_B = "88888888-8888-4888-8888-888888888888";

let app: FastifyInstance | undefined;
const fake = {
  search: vi.fn(),
  resolve: vi.fn(),
  storeSingleSourceSummary: vi.fn(),
  discloseEgress: vi.fn(),
  storeFusedConclusion: vi.fn(),
  updateEgressNotificationSetting: vi.fn(),
  listNotifications: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  __setAuthIdentityForTests({ spaceId: SPACE_A, userId: USER });
  __setCrossSpaceRetrievalServiceFactoryForTests(() => fake);
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: "postgresql://server@db/agent_space" }), [crossSpaceRetrievalModule]);
});

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setCrossSpaceRetrievalServiceFactoryForTests(null);
  await app?.close();
  app = undefined;
});

describe("cross-Space retrieval routes", () => {
  it("registers exactly the enumerated retrieval exception types", () => {
    expect(personalAggregatedRetrievalRegistry.objectTypes().sort()).toEqual(
      [...PERSONAL_AGGREGATED_RESOURCE_TYPES].sort(),
    );
  });

  it("exposes the explicit aggregated search and pointer resolution boundaries", async () => {
    fake.search.mockResolvedValue({
      session_id: DISCLOSURE,
      items: [],
      source_space_ids: [],
      fused_conclusion: null,
      canonical_write_performed: false,
    });
    fake.resolve.mockResolvedValue({ items: [], unresolved_pointer_ids: [POINTER_A] });

    const search = await app!.inject({
      method: "POST",
      url: "/api/v1/me/retrieval/search",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", resource_types: ["knowledge_item"] }),
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ fused_conclusion: null, canonical_write_performed: false });
    expect(fake.search).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, query: "alpha" }));

    const resolve = await app!.inject({
      method: "POST",
      url: "/api/v1/me/retrieval/pointers/resolve",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pointer_ids: [POINTER_A] }),
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().unresolved_pointer_ids).toEqual([POINTER_A]);
  });

  it("requires disclosure before the separate fused-conclusion store route", async () => {
    fake.discloseEgress.mockResolvedValue({
      disclosure_id: DISCLOSURE,
      expires_at: "2026-08-07T04:00:00.000Z",
      source_spaces: [
        { space_id: SPACE_A, space_name: "A", egress_notifications_enabled: true, pointers: [{ resource_type: "knowledge_item", id: POINTER_A }] },
        { space_id: SPACE_B, space_name: "B", egress_notifications_enabled: false, pointers: [{ resource_type: "knowledge_item", id: POINTER_B }] },
      ],
    });
    fake.storeFusedConclusion.mockResolvedValue({ artifact_id: ARTIFACT, egress_record_ids: [EGRESS_A, EGRESS_B] });

    const disclosed = await app!.inject({
      method: "POST",
      url: "/api/v1/me/retrieval/egress/disclose",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pointer_ids: [POINTER_A, POINTER_B] }),
    });
    expect(disclosed.statusCode, disclosed.body).toBe(200);
    expect(disclosed.json().source_spaces).toHaveLength(2);

    const stored = await app!.inject({
      method: "POST",
      url: "/api/v1/me/retrieval/fused-conclusions",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        disclosure_id: DISCLOSURE,
        pointer_ids: [POINTER_A, POINTER_B],
        conclusion: "explicit conclusion",
      }),
    });
    expect(stored.statusCode).toBe(201);
    expect(stored.json()).toEqual({ artifact_id: ARTIFACT, egress_record_ids: [EGRESS_A, EGRESS_B] });
  });

  it("exposes the mutable setting and member notification read", async () => {
    fake.updateEgressNotificationSetting.mockResolvedValue({
      space_id: SPACE_A,
      egress_notifications_enabled: false,
      updated_at: "2026-08-07T04:00:00.000Z",
    });
    fake.listNotifications.mockResolvedValue({ items: [] });

    const updated = await app!.inject({
      method: "PATCH",
      url: `/api/v1/spaces/${SPACE_A}/egress-notifications`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ egress_notifications_enabled: false }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().egress_notifications_enabled).toBe(false);

    const notices = await app!.inject({ method: "GET", url: "/api/v1/me/notifications" });
    expect(notices.statusCode).toBe(200);
    expect(notices.json()).toEqual({ items: [] });
  });
});
