import { mkdtemp, rm, writeFile, readFile, symlink, link, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localToolBridgeSupported, localToolRequest, startLocalToolBridge, type LocalToolBridge } from "../src/localBridge.ts";
import { parseToolRequest, TOOL_REQUEST_LIMIT, type ToolRequest } from "../src/toolHttp.ts";

let root: string;
const bridges: LocalToolBridge[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rainver-tool-bridge-")); });
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await rm(root, { recursive: true, force: true });
});
async function bridge(invoke: Parameters<typeof startLocalToolBridge>[1]) {
  const value = await startLocalToolBridge(root, invoke);
  bridges.push(value);
  return value;
}
const request = (): ToolRequest => ({ id: randomUUID(), method: "GET", path: "tools" });
async function responseFile(directory: string, id: string): Promise<unknown> {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(join(directory, `${id}.response`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("missing bridge response");
}

describe("Run-local CLI bridge", () => {
  it("keeps concurrent callers and separate launches isolated", async () => {
    const first = await bridge(async (r) => ({ status: 200, text: r.id }));
    const second = await bridge(async () => ({ status: 403, text: "other Run" }));
    const inputs = Array.from({ length: 20 }, request);
    const responses = await Promise.all(inputs.map((input) => localToolRequest(first.directory, input)));
    expect(responses.map((r) => r.text)).toEqual(inputs.map((r) => r.id));
    await first.close();
    await expect(localToolRequest(second.directory, request())).resolves.toEqual({ status: 403, text: "other Run" });
  });

  it("refuses symlink and hardlink payloads without dispatching them", async () => {
    const invoke = vi.fn(async () => ({ status: 200, text: "unexpected" }));
    const host = await bridge(invoke);
    for (const kind of ["symlink", "hardlink"]) {
      const input = request();
      const outside = join(root, `${kind}.json`);
      await writeFile(outside, JSON.stringify(input));
      const path = join(host.directory, `${input.id}.request`);
      if (kind === "symlink") await symlink(outside, path);
      else await link(outside, path);
      expect(await responseFile(host.directory, input.id)).toHaveProperty("error");
      expect(await readFile(outside, "utf8")).toBe(JSON.stringify(input));
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pins the directory instead of following a replacement symlink", async () => {
    const invoke = vi.fn(async () => ({ status: 200, text: "pinned" }));
    const host = await bridge(invoke);
    const moved = `${host.directory}-moved`;
    await rename(host.directory, moved);
    const outside = await mkdtemp(join(root, "outside-"));
    await symlink(outside, host.directory);
    const input = request();
    await writeFile(join(moved, `${input.id}.request`), JSON.stringify(input));
    expect(await responseFile(moved, input.id)).toEqual({ status: 200, text: "pinned" });
    await expect(readFile(join(outside, `${input.id}.response`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized payloads before invoking the Host handler", async () => {
    const invoke = vi.fn(async () => ({ status: 200, text: "unexpected" }));
    const host = await bridge(invoke);
    const input = request();
    await writeFile(join(host.directory, `${input.id}.request`), "x".repeat(TOOL_REQUEST_LIMIT + 1));
    expect(await responseFile(host.directory, input.id)).toHaveProperty("error");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("aborts in-flight work on close and never retries an uncertain write", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const invoke = vi.fn(async (_request: ToolRequest, signal: AbortSignal) => {
      started();
      await delay(10_000, undefined, { signal });
      return { status: 200, text: "done" };
    });
    const host = await bridge(invoke);
    const input: ToolRequest = { id: randomUUID(), method: "POST", path: "tools/task.report", body: {} };
    const result = localToolRequest(host.directory, input);
    const assertion = expect(result).rejects.toThrow();
    await ready;
    await host.close();
    await assertion;
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(localToolRequest(host.directory, request())).rejects.toThrow();
  });

  it("reports uncertainty on a response timeout without resubmitting", async () => {
    const invoke = vi.fn(async (_r: ToolRequest, signal: AbortSignal) => {
      await delay(10_000, undefined, { signal });
      return { status: 200, text: "done" };
    });
    const host = await bridge(invoke);
    await expect(localToolRequest(host.directory, request(), 80)).rejects.toThrow("outcome is unknown");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects arbitrary routes, identities and non-object writes at the transport boundary", () => {
    for (const invalid of [
      { ...request(), path: "../../admin" },
      // The URL parser normalizes each of these into another Run route.
      { ...request(), path: "tools/.." },
      { ...request(), path: "tools/." },
      { ...request(), path: "tools/%2e%2e" },
      { ...request(), path: "tools/.%2E" },
      { ...request(), path: "tools/%2E" },
      { ...request(), path: "tools/..%2Fadmin" },
      { ...request(), path: "tools/a%5Cb" },
      { ...request(), path: "tools/%E0%A4%A" },
      { ...request(), path: "tools/a/b" },
      { ...request(), path: "https://other.test" },
      { ...request(), method: "DELETE" },
      { ...request(), method: "POST", path: "tools/task.report", body: [] },
    ]) expect(() => parseToolRequest(invalid)).toThrow();
    expect(parseToolRequest({ ...request(), token: "ignored", runId: "another" })).not.toHaveProperty("token");
    for (const path of ["tools", "tools/task.report", "tools/artifact.submit", "tools/a%20b", "tools/..."]) {
      expect(parseToolRequest({ ...request(), path }).path).toBe(path);
    }
  });
});

describe("Run-local CLI bridge on macOS", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  function platform(value: NodeJS.Platform) { Object.defineProperty(process, "platform", { ...original, value }); }
  afterEach(() => { Object.defineProperty(process, "platform", original); });

  it("is offered on Linux and macOS only", async () => {
    expect(localToolBridgeSupported("linux")).toBe(true);
    expect(localToolBridgeSupported("darwin")).toBe(true);
    expect(localToolBridgeSupported("win32")).toBe(false);
    platform("win32");
    await expect(startLocalToolBridge(root, async () => ({ status: 200, text: "" }))).rejects.toThrow("Linux or macOS");
  });

  it("serves calls without procfs", async () => {
    platform("darwin");
    const host = await bridge(async (r) => ({ status: 200, text: r.id }));
    const input = request();
    await expect(localToolRequest(host.directory, input)).resolves.toEqual({ status: 200, text: input.id });
  });

  it("fails closed when the directory is replaced, never writing through the replacement", async () => {
    platform("darwin");
    const invoke = vi.fn(async () => ({ status: 200, text: "pinned" }));
    const host = await bridge(invoke);
    const moved = `${host.directory}-moved`;
    await rename(host.directory, moved);
    const outside = await mkdtemp(join(root, "outside-"));
    await symlink(outside, host.directory);
    const input = request();
    await writeFile(join(outside, `${input.id}.request`), JSON.stringify(input));
    await writeFile(join(moved, `${input.id}.request`), JSON.stringify(input));
    await delay(400);
    expect(invoke).not.toHaveBeenCalled();
    await expect(readFile(join(outside, `${input.id}.response`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(moved, `${input.id}.response`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(localToolRequest(host.directory, request())).rejects.toThrow();
    await host.close();
    // Cleanup never recurses through a path that no longer names the bridge.
    await expect(readFile(join(outside, `${input.id}.request`), "utf8")).resolves.toBe(JSON.stringify(input));
  });
});
