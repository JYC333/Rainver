import { describe, expect, it } from "vitest";
import { createCliConversationController } from "../src/modules/runs/cliConversationProtocol.js";

/**
 * `codex-acp` announces `_auth/status_update` immediately after `initialize`.
 * The controller knew three inbound shapes and failed the whole turn on
 * anything else, so a Room turn to Codex on the built-in host died with
 * "unsupported protocol message" before it ever prompted. The underscore is
 * ACP's own marker for a vendor extension, so more of these are coming.
 */
describe("an ACP notification the controller does not recognise", () => {
  const controller = () => createCliConversationController({
    adapter_type: "codex_cli",
    prompt: "hello",
    cwd: "/workspace",
  })!;

  it("is ignored rather than failing the turn", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = controller();
    acp.start((message) => sent.push(message));
    acp.receive({ jsonrpc: "2.0", method: "_auth/status_update", params: { status: "ok" } }, (m) => sent.push(m), () => {});
    expect(acp.result().error).toBeNull();
    expect(acp.result().completed).toBe(false);
  });

  it("still answers and then stops on an interactive request, which the peer does wait on", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = controller();
    acp.start((message) => sent.push(message));
    acp.receive({ jsonrpc: "2.0", id: 99, method: "fs/write_text_file", params: {} }, (m) => sent.push(m), () => {});
    const refusal = sent.find((message) => message.id === 99);
    expect((refusal?.error as { code: number } | undefined)?.code).toBe(-32601);
    // Deliberately still terminal: a runtime blocked on an interactive method
    // Rainver will not serve has nowhere to go, unlike a notification nobody
    // is waiting on.
    expect(acp.result().error).toContain("unsupported interactive method");
  });

  it("still fails on a response carrying an id nothing asked for", () => {
    const acp = controller();
    acp.start(() => {});
    acp.receive({ jsonrpc: "2.0", id: 4242, result: {} }, () => {}, () => {});
    expect(acp.result().error).toContain("unexpected response id");
  });
});

/**
 * Which options a session has depends on the ones already set. Codex offers
 * `fast-mode` at `session/new` and withdraws it once the model is one that
 * does not support it — and `model` is deliberately set first, so the composer
 * sending back every option it was shown made a withdrawn one fatal. Two Room
 * turns died on `fast-mode: false`, a value that asks for nothing.
 */
describe("a session option that disappears once the model is chosen", () => {
  const withConfig = (config: Parameters<typeof createCliConversationController>[0]["session_config"]) =>
    createCliConversationController({ adapter_type: "codex_cli", prompt: "hello", cwd: "/workspace", session_config: config })!;

  const advertise = (ids: Array<{ id: string; type: "select" | "boolean"; category: string; current: unknown; choices?: string[] }>) => ({
    configOptions: ids.map((option) => ({
      id: option.id,
      type: option.type,
      category: option.category,
      currentValue: option.current,
      ...(option.choices ? { options: option.choices.map((value) => ({ value })) } : {}),
    })),
  });

  it("skips it instead of failing the turn", () => {
    const sent: Record<string, unknown>[] = [];
    const acp = withConfig([
      { id: "model", type: "select", value: "spark", category: "model" },
      { id: "fast-mode", type: "boolean", value: false, category: "model_config" },
    ]);
    acp.start((m) => sent.push(m));
    acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, (m) => sent.push(m), () => {});
    // `session/new` still has fast-mode; the reply to setting the model does not.
    acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s1", ...advertise([
      { id: "model", type: "select", category: "model", current: "other", choices: ["spark", "other"] },
      { id: "fast-mode", type: "boolean", category: "model_config", current: false },
    ]) } }, (m) => sent.push(m), () => {});
    acp.receive({ jsonrpc: "2.0", id: 3, result: advertise([
      { id: "model", type: "select", category: "model", current: "spark", choices: ["spark", "other"] },
    ]) }, (m) => sent.push(m), () => {});
    expect(acp.result().error).toBeNull();
    // It moved on to the prompt rather than stopping on the withdrawn option.
    expect(sent.some((m) => m.method === "session/prompt")).toBe(true);
  });
});

/**
 * A session the runtime never answered a prompt in has no transcript on disk,
 * so resuming it fails with "no rollout found" — reported as an opaque
 * "Internal error" one turn *after* the one that actually broke. Verified on
 * the built-in host: the rollout file appears only for the turn that prompted.
 */
describe("the vendor session a failed turn leaves behind", () => {
  const reachSession = (config: Parameters<typeof createCliConversationController>[0]["session_config"]) => {
    const sent: Record<string, unknown>[] = [];
    const acp = createCliConversationController({
      adapter_type: "codex_cli", prompt: "hello", cwd: "/workspace", session_config: config,
    })!;
    acp.start((m) => sent.push(m));
    acp.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, (m) => sent.push(m), () => {});
    acp.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: "s-1", configOptions: [
      { id: "mode", type: "select", category: "mode", currentValue: "agent", options: [{ value: "agent" }] },
    ] } }, (m) => sent.push(m), () => {});
    return { acp, sent };
  };

  it("is not reported when the turn died before prompting", () => {
    // A selection whose shape the session contradicts: fatal, and before any prompt.
    const { acp, sent } = reachSession([{ id: "mode", type: "boolean", value: true, category: "mode" }]);
    expect(acp.result().error).toContain("different shape");
    expect(sent.some((m) => m.method === "session/prompt")).toBe(false);
    expect(acp.result().external_session_id).toBeNull();
  });

  it("is reported once a prompt has gone out, which is when a transcript exists", () => {
    const { acp, sent } = reachSession([{ id: "mode", type: "select", value: "agent", category: "mode" }]);
    expect(sent.some((m) => m.method === "session/prompt")).toBe(true);
    expect(acp.result().external_session_id).toBe("s-1");
  });
});
