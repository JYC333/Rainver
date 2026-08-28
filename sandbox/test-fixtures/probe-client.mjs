import { createConnection } from "node:net";

const terminalMode = process.env.PROBE_TERMINAL_MODE === "pty" ? "pty" : "pipe";

const request = {
  protocol_version: 2,
  run_id: "boundary-probe",
  scope_id: "selected",
  runtime: "codex_cli",
  runtime_tool_id: "codex_cli/versions/1/node_modules/.bin/codex",
  arguments: [],
  sandbox_mode: "read_only",
  egress_profile: "none",
  mounts: [
    { root: "workspaces", id: "selected", target: "/workspace", access: "read_only" },
    { root: "sandboxes", id: "delivery", target: "/delivery", access: "read_only" },
    { root: "runtime_tools", id: "codex_cli/versions/1/node_modules/.bin/codex", target: "/runtime-tool", access: "read_only" },
    { root: "run_homes", id: "run-1", target: "/home/sandbox", access: "read_write" },
  ],
  environment: {},
  timeout_seconds: 10,
  stdin_mode: "none",
  terminal_mode: terminalMode,
};

await new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port: 8020 });
  let buffer = "", stdout = "", stderr = "";
  socket.on("connect", () => socket.write(`${JSON.stringify({ type: "launch", token: "phase8-probe-token", request })}\n`));
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.type === "stdout") stdout += frame.value;
      if (frame.type === "stderr") stderr += frame.value;
      if (frame.type === "error") reject(new Error(`${frame.code}: ${frame.message}: ${stderr}`));
      if (frame.type === "exit") {
        if (frame.returncode === 0 && stdout.replaceAll("\r\n", "\n") === "sandbox-boundary-ok\n") resolve();
        else reject(new Error(`probe failed: ${JSON.stringify({ frame, stdout })}`));
      }
    }
  });
  socket.on("error", reject);
});

process.stdout.write("sandbox-boundary-ok\n");
