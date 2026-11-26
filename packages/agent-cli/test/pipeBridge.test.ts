import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { pipeToolRequest, startPipeToolBridge } from "../src/pipeBridge.ts";

it("authenticates the launch-local IPC client and preserves its deliberate key", async () => {
  const invoke = vi.fn(async () => ({ status: 200, text: '{"ok":true}' }));
  const bridge = await startPipeToolBridge(invoke);
  const request = { id: randomUUID(), method: "POST" as const, path: "tools/task.report", body: {}, idempotency_key: "original-key" };
  try {
    const wrongKey = bridge.endpoint.replace(/:[^:]+$/, ":" + "x".repeat(43));
    await expect(pipeToolRequest(wrongKey, request, 2000)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(pipeToolRequest(bridge.endpoint, request, 2000)).resolves.toEqual({ status: 200, text: '{"ok":true}' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
  } finally {
    await bridge.close();
  }
  await expect(pipeToolRequest(bridge.endpoint, request, 2000)).rejects.toThrow();
});
