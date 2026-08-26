import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { customSourcePolicyEnvelope, runnerSettings } from "./support/customSourceFixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCustomSourceHandlerOutput } from "../src/modules/sources/customSources/customSourceContractValidator.js";
import { fetchCustomSourceEndpointHtml } from "../src/modules/sources/customSources/customSourceEndpointFetch.js";
import { generateCustomSourceHandlerSource } from "../src/modules/sources/customSources/customSourceHandlerTemplate.js";
import { cleanupSandbox, CustomSourceRunner, type CustomSourceRunnerSettings } from "../src/modules/sources/customSources/customSourceRunner.js";

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

      const html = await fetchCustomSourceEndpointHtml(`${ORIGIN}/redirect-same-origin`, runnerSettings(), POLICY_ENVELOPE);
      expect(html).toBe("hello pi world");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${ORIGIN}/ok`);
    });

    it("rejects an off-origin redirect before following it", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://other.example/off-origin" } }),
      );

      await expect(
        fetchCustomSourceEndpointHtml(`${ORIGIN}/redirect-off-origin`, runnerSettings(), POLICY_ENVELOPE),
      ).rejects.toThrow("not allowed by the handler policy envelope");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("truncates fetched HTML by UTF-8 byte length", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("hello pi world", { status: 200 }));

      const html = await fetchCustomSourceEndpointHtml(
        `${ORIGIN}/ok`,
        runnerSettings({ download_bytes_max: 8 }),
        { ...POLICY_ENVELOPE, limits: { ...POLICY_ENVELOPE.limits, max_download_bytes: 8 } },
      );
      expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(8);
      expect(html).toBe("hello pi");
    });
  });
});

describe("sourceCustomSourceHandlerTemplate", () => {
  const enabledSettings = () => runnerSettings();

  const POLICY_ENVELOPE = customSourcePolicyEnvelope({ allowed_network_origins: ["https://example.com"] });

  async function runGeneratedHandler(
    settings: CustomSourceRunnerSettings,
    listSelector: string | null,
    fetchedHtml: string,
  ) {
    const workDir = await mkdtemp(join(tmpdir(), "custom-source-template-test-"));
    const entrypointPath = join(workDir, "handler.cjs");
    await writeFile(entrypointPath, generateCustomSourceHandlerSource({ listSelector }), "utf8");

    const runner = new CustomSourceRunner(settings);
    const result = await runner.run({
      policyEnvelope: POLICY_ENVELOPE,
      handlerInput: {
        contract_version: "custom_source.handler_input.v1",
        run: {
          mode: "test",
          job_id: "job-1",
          connection_id: "conn-1",
          handler_version_id: "handler-1",
          started_at: new Date().toISOString(),
        },
        source: {
          name: "Example Source",
          endpoint_url: "https://example.com/list",
          config: { fetched_html: fetchedHtml },
        },
        policy: {
          allowed_network_origins: POLICY_ENVELOPE.allowed_network_origins,
          capture_policy: POLICY_ENVELOPE.capture_policy,
          retention_policy: POLICY_ENVELOPE.retention_policy,
          limits: POLICY_ENVELOPE.limits,
        },
      },
      handlerEntrypointPath: entrypointPath,
    });
    await rm(workDir, { recursive: true, force: true });
    return result;
  }

  describe("generateCustomSourceHandlerSource", () => {
    it("single_page mode extracts one item from the fetched page title/body via the real sandboxed runner", async () => {
      const result = await runGeneratedHandler(
        enabledSettings(),
        null,
        "<html><head><title>My Page Title</title></head><body><p>Hello world content here.</p></body></html>",
      );
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      expect(result.raw_output_json).not.toBeNull();
      await cleanupSandbox(result.sandbox_files_root);

      const validation = await validateCustomSourceHandlerOutput({
        raw: JSON.parse(result.raw_output_json!),
        limits: POLICY_ENVELOPE.limits,
        allowedNetworkOrigins: POLICY_ENVELOPE.allowed_network_origins,
        sandboxFilesRoot: result.sandbox_files_root,
      });
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      expect(validation.output.items).toHaveLength(1);
      expect(validation.output.items[0]?.title).toBe("My Page Title");
      expect(validation.output.items[0]?.source_uri).toBe("https://example.com/list");
      expect(validation.output.items[0]?.excerpt).toContain("Hello world content here.");
    });

    it("list mode extracts one item per matching block, resolving relative links against endpoint_url", async () => {
      const html = `<html><body>
        <div class="article"><a href="/a1">First Title</a><p>First excerpt text.</p></div>
        <div class="article"><a href="/a2">Second Title</a><p>Second excerpt text.</p></div>
      </body></html>`;
      const result = await runGeneratedHandler(enabledSettings(), "article", html);
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      await cleanupSandbox(result.sandbox_files_root);

      const validation = await validateCustomSourceHandlerOutput({
        raw: JSON.parse(result.raw_output_json!),
        limits: POLICY_ENVELOPE.limits,
        allowedNetworkOrigins: POLICY_ENVELOPE.allowed_network_origins,
        sandboxFilesRoot: result.sandbox_files_root,
      });
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      expect(validation.output.items).toHaveLength(2);
      expect(validation.output.items[0]?.title).toBe("First Title");
      expect(validation.output.items[0]?.source_uri).toBe("https://example.com/a1");
      expect(validation.output.items[1]?.title).toBe("Second Title");
      expect(validation.output.items[1]?.source_uri).toBe("https://example.com/a2");
    });

    it("produces no items and a diagnostic warning when the fetched page has no content", async () => {
      const result = await runGeneratedHandler(enabledSettings(), "article", "<html><body></body></html>");
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      await cleanupSandbox(result.sandbox_files_root);
      const output = JSON.parse(result.raw_output_json!);
      expect(output.items).toHaveLength(0);
      expect(output.diagnostics.warnings.length).toBeGreaterThan(0);
    });
  });
});
