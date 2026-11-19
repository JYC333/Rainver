import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Awaited SDK cleanup preparation for staged binaries.
 * Unknown upstream layouts fail candidate preparation rather than losing this
 * credential-persistence guarantee. The real-package cleanup contract decides
 * when upstream has made the fix obsolete.
 */
export function prepareClaudeAcp(packageRoot: string): void {
  const agentFile = join(packageRoot, "dist/acp-agent.js"), indexFile = join(packageRoot, "dist/index.js");
  const agent = readFileSync(agentFile, "utf8"), index = readFileSync(indexFile, "utf8");
  // Each file is patched on its own, so a run interrupted between the two
  // renames is completed by the next run instead of reading as a new layout.
  const agentDone = agent.includes("rainverQueryCleanup"), indexDone = index.includes("rainverShutdown");
  if (agentDone && indexDone) return;
  const close = "        session.query.close();";
  const wait = "        this.closeQueryStream(session);\n        // Abort the SDK abort signal";
  const shutdown = /    async function shutdown\(\) \{\n        await (acp|agent)\.dispose\(\)\.catch\(\(err\) => \{\n            console\.error\("Error during cleanup:", err\);\n        \}\);\n        process\.exit\(0\);\n    \}/;
  if ((!agentDone && (agent.split(close).length !== 2 || !agent.includes(wait))) || (!indexDone && !shutdown.test(index))) {
    throw new Error("Claude ACP cleanup layout changed; candidate requires the shutdown compatibility contract before promotion");
  }
  const changedAgent = agentDone ? null : agent.replace(close, `        session.rainverQueryCleanup = session.query.return(undefined).catch((error) => {
            this.logger.error("Error during query cleanup:", error);
        });`).replace(wait, "        this.closeQueryStream(session);\n        await session.rainverQueryCleanup;\n        // Abort the SDK abort signal");
  const changedIndex = indexDone ? null : index.replace(shutdown, (_match, owner: string) => `    let rainverShutdown;
    function shutdown() {
        rainverShutdown ??= ${owner}.dispose().catch((err) => {
            console.error("Error during cleanup:", err);
        }).finally(() => {
            process.stdin.destroy();
            process.exitCode = 0;
        });
        return rainverShutdown;
    }`);
  // Rename breaks pnpm hardlinks; never edit the content-addressed store inode.
  for (const [file, text] of [[agentFile, changedAgent], [indexFile, changedIndex]] as const) {
    if (text === null) continue;
    const temporary = `${file}.rainver-${process.pid}`;
    try {
      writeFileSync(temporary, text, { mode: 0o755 });
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
