import { describe, expect, it } from "vitest";
import { probeAcpHealth } from "../src/acpProbe.js";

const cwd = process.cwd();

describe("managed ACP health handshake", () => {
  it("accepts a valid initialize response without requiring session authentication", async () => {
    const script = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      " input += chunk;",
      " if (!input.includes('\\n')) return;",
      " const request = JSON.parse(input.trim());",
      " process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{protocolVersion:1, agentInfo:{name:'test', version:'1'}, agentCapabilities:{}}}) + '\\n');",
      "});",
    ].join("\n");
    await expect(probeAcpHealth(process.execPath, ["-e", script], {}, cwd)).resolves.toBe(true);
  });

  it("rejects protocol errors, malformed initialize results, and agents that do not answer", async () => {
    const errorScript = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-1,message:'no'}})+'\\n'))";
    const malformedScript = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n'))";
    const incompatibleProtocolScript = "process.stdin.once('data', () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:2}})+'\\n'))";
    const quietScript = "process.stdin.resume(); setInterval(() => {}, 1000)";
    await expect(probeAcpHealth(process.execPath, ["-e", errorScript], {}, cwd)).resolves.toBe(false);
    await expect(probeAcpHealth(process.execPath, ["-e", malformedScript], {}, cwd)).resolves.toBe(false);
    await expect(probeAcpHealth(process.execPath, ["-e", incompatibleProtocolScript], {}, cwd)).resolves.toBe(false);
    await expect(probeAcpHealth(process.execPath, ["-e", quietScript], {}, cwd, 20)).resolves.toBe(false);
  });
});
