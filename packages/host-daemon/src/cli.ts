#!/usr/bin/env node
import { register } from "./commands/register.js";
import { workspaceAdd, workspaceList, workspaceRemove } from "./commands/workspace.js";
import { runService } from "./commands/run.js";
import { updateHost, type UpdateHostOptions } from "./commands/update.js";
import { daemonVersion } from "./version.js";
import { startInstalledService } from "./service.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function requireFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, sub, ...rest] = argv;

  if (command === "--version" || command === "version") {
    console.log(daemonVersion());
    return;
  }

  if (command === "register") {
    const result = await register({ serverUrl: requireFlag(argv, "server"), pairingCode: requireFlag(argv, "code") });
    console.log(`Registered as '${result.name}' (host ${result.host_id}).`);
    if (await startInstalledService()) console.log("Rainver Host background service started.");
    return;
  }

  if (command === "workspace") {
    if (sub === "add") {
      const path = rest[0];
      if (!path || path.startsWith("--")) throw new Error("usage: rainver-host workspace add <path> --project <project_id> [--name <name>]");
      const projectId = requireFlag(rest, "project");
      const name = flag(rest, "name") ?? path.split("/").filter(Boolean).pop() ?? path;
      const created = await workspaceAdd({ path, projectId, name });
      console.log(`Registered workspace '${created.name}' (${created.id}) -> ${path}`);
      return;
    }
    if (sub === "list") {
      const workspaces = await workspaceList();
      if (workspaces.length === 0) {
        console.log("No workspaces registered on this host.");
        return;
      }
      for (const workspace of workspaces) {
        console.log(`${workspace.id}  ${workspace.name}  ${workspace.local_path ?? "(no local mapping)"}`);
      }
      return;
    }
    if (sub === "remove") {
      const id = rest[0];
      if (!id) throw new Error("usage: rainver-host workspace remove <workspace_id>");
      await workspaceRemove({ id });
      console.log(`Removed workspace ${id}.`);
      return;
    }
    throw new Error("usage: rainver-host workspace <add|list|remove>");
  }

  if (command === "run") {
    await runService();
    return;
  }

  if (command === "update") {
    const enableAutoUpdate = argv.includes("--auto-update");
    const disableAutoUpdate = argv.includes("--no-auto-update");
    if (enableAutoUpdate && disableAutoUpdate) {
      throw new Error("--auto-update and --no-auto-update cannot be used together");
    }
    const requestedChannel = flag(argv, "channel");
    let channel: UpdateHostOptions["channel"];
    switch (requestedChannel) {
      case undefined:
        break;
      case "stable":
      case "edge":
      case "nightly":
        channel = requestedChannel;
        break;
      default:
        throw new Error("--channel must be stable, edge, or nightly");
    }
    await updateHost({
      ...(enableAutoUpdate ? { autoUpdate: "enable" as const } : {}),
      ...(disableAutoUpdate ? { autoUpdate: "disable" as const } : {}),
      ...(channel ? { channel } : {}),
    });
    return;
  }

  throw new Error(
    "usage: rainver-host <register|workspace|run|update|version>\n" +
      "  register --server <url> --code <pairing-code>\n" +
      "  workspace add <path> --project <project_id> [--name <name>]\n" +
      "  workspace list\n" +
      "  workspace remove <workspace_id>\n" +
      "  run\n" +
      "  update [--channel <stable|edge|nightly>] [--auto-update|--no-auto-update]\n" +
      "  version",
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
