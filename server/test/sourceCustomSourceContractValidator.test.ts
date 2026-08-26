import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateCustomSourceHandlerOutput } from "../src/modules/sources/customSources/customSourceContractValidator.js";

const LIMITS = {
  timeout_ms: 30000,
  max_download_bytes: 1_000_000,
  max_output_bytes: 1_000_000,
  max_files: 5,
  max_items: 3,
  max_evidence_items: 5,
  log_max_bytes: 65536,
};

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: "custom_source.handler_output.v1",
    items: [
      {
        external_id: "article-1",
        title: "Article title",
        source_uri: "https://example.com/research/article-1",
        excerpt: "Short excerpt",
        snapshots: [{ snapshot_type: "raw_html", file_path: "article-1.html", mime_type: "text/html" }],
        evidence: [{ evidence_type: "excerpt", title: "Quote", content_excerpt: "A passage.", confidence: 0.8 }],
      },
    ],
    diagnostics: { warnings: [] },
    ...overrides,
  };
}

let sandboxFilesRoot: string;

beforeEach(async () => {
  sandboxFilesRoot = await mkdtemp(join(tmpdir(), "custom-source-validator-"));
  await writeFile(join(sandboxFilesRoot, "article-1.html"), "<html>hi</html>", "utf8");
});

afterEach(async () => {
  await rm(sandboxFilesRoot, { recursive: true, force: true });
});

const baseOpts = () => ({
  limits: LIMITS,
  allowedNetworkOrigins: ["https://example.com"],
  sandboxFilesRoot,
});

describe("validateCustomSourceHandlerOutput", () => {
  it("accepts a well-formed output referencing an existing sandbox file", async () => {
    const result = await validateCustomSourceHandlerOutput({ raw: validOutput(), ...baseOpts() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.items).toHaveLength(1);
      expect(result.totalFileBytes).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown contract version", async () => {
    const result = await validateCustomSourceHandlerOutput({
      raw: validOutput({ contract_version: "custom_source.handler_output.v2" }),
      ...baseOpts(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a source_uri outside the approved network origins", async () => {
    const raw = validOutput();
    (raw.items[0] as { source_uri: string }).source_uri = "https://evil.example.net/x";
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("source_uri"))).toBe(true);
  });

  it("rejects an absolute snapshot file_path", async () => {
    const raw = validOutput();
    (raw.items[0] as { snapshots: Array<{ file_path: string }> }).snapshots[0]!.file_path = "/etc/passwd";
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("safe relative path"))).toBe(true);
  });

  it("rejects a snapshot file_path that escapes the sandbox via ..", async () => {
    const raw = validOutput();
    (raw.items[0] as { snapshots: Array<{ file_path: string }> }).snapshots[0]!.file_path =
      "../outside.html";
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
  });

  it("rejects a snapshot file_path that does not exist in the sandbox", async () => {
    const raw = validOutput();
    (raw.items[0] as { snapshots: Array<{ file_path: string }> }).snapshots[0]!.file_path = "missing.html";
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
  });

  it("rejects when item count exceeds max_items", async () => {
    const raw = validOutput();
    const items = raw.items as unknown[];
    items.push({ ...items[0]! }, { ...items[0]! }, { ...items[0]! });
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("max_items"))).toBe(true);
  });

  it("rejects duplicate external_id across items", async () => {
    const raw = validOutput();
    const items = raw.items as Array<{ external_id: string }>;
    items.push({ ...items[0]! });
    const result = await validateCustomSourceHandlerOutput({
      raw,
      limits: { ...LIMITS, max_items: 5 },
      allowedNetworkOrigins: ["https://example.com"],
      sandboxFilesRoot,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("duplicate external_id"))).toBe(true);
  });

  it("rejects a source_uri whose host merely starts with an allowed origin's host (no prefix-match bypass)", async () => {
    const raw = validOutput();
    (raw.items[0] as { source_uri: string }).source_uri = "https://example.com.evil.net/x";
    const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("source_uri"))).toBe(true);
  });

  it("rejects a snapshot file_path that is a symlink, even when it points inside the sandbox", async () => {
    const targetOutsideSandbox = await mkdtemp(join(tmpdir(), "custom-source-validator-outside-"));
    await writeFile(join(targetOutsideSandbox, "secret.txt"), "host secret", "utf8");
    try {
      await symlink(join(targetOutsideSandbox, "secret.txt"), join(sandboxFilesRoot, "link.html"));
      const raw = validOutput();
      (raw.items[0] as { snapshots: Array<{ file_path: string }> }).snapshots[0]!.file_path = "link.html";
      const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.includes("symlink"))).toBe(true);
    } finally {
      await rm(targetOutsideSandbox, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot file_path reached through a symlinked intermediate directory that escapes the sandbox", async () => {
    const targetOutsideSandbox = await mkdtemp(join(tmpdir(), "custom-source-validator-outside-dir-"));
    await writeFile(join(targetOutsideSandbox, "secret.txt"), "host secret", "utf8");
    try {
      await symlink(targetOutsideSandbox, join(sandboxFilesRoot, "linked-dir"));
      const raw = validOutput();
      (raw.items[0] as { snapshots: Array<{ file_path: string }> }).snapshots[0]!.file_path =
        "linked-dir/secret.txt";
      const result = await validateCustomSourceHandlerOutput({ raw, ...baseOpts() });
      expect(result.ok).toBe(false);
    } finally {
      await rm(targetOutsideSandbox, { recursive: true, force: true });
    }
  });

  it("denies all network origins when the policy envelope allowlist is empty (fail closed)", async () => {
    const result = await validateCustomSourceHandlerOutput({
      raw: validOutput(),
      limits: LIMITS,
      allowedNetworkOrigins: [],
      sandboxFilesRoot,
    });
    expect(result.ok).toBe(false);
  });
});
