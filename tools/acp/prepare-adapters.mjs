import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareClaudeAcp } from "../../packages/host-daemon/src/acpAdapterCompatibility.ts";

const catalogFile = fileURLToPath(new URL("../../packages/protocol/src/acpAdapters.json", import.meta.url));
const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--resolve-candidates") {
  args.shift();
  const require = createRequire(resolve("packages/host-adapters/package.json"));
  for (const adapter of Object.values(catalog)) {
    const entry = require.resolve(`${adapter.package}/dist/index.js`);
    const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8"));
    adapter.version = manifest.version;
  }
  writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
}
for (const root of args.length ? args : ["packages/host-adapters", "packages/host-daemon"]) {
  const require = createRequire(resolve(root, "package.json"));
  for (const adapter of Object.values(catalog)) {
    let entry;
    try { entry = require.resolve(`${adapter.package}/dist/index.js`); }
    catch (error) {
      if (!args.length && error.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    const packageRoot = resolve(dirname(entry), "..");
    const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== adapter.package || manifest.version !== adapter.version) {
      throw new Error(`${root}: installed ${manifest.name}@${manifest.version} does not match the repository ACP release`);
    }
    if (adapter.package === "@agentclientprotocol/claude-agent-acp") prepareClaudeAcp(packageRoot);
  }
}
