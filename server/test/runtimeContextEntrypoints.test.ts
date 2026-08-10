import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY,
  RUNTIME_INVOCATION_INVENTORY,
} from "../src/modules/runtimeContext";

const modulesRoot = join(__dirname, "..", "src", "modules");
const providerInvocationSource = readFileSync(
  join(modulesRoot, "providers", "invocation", "invocation.ts"),
  "utf8",
);
const PROVIDER_INVOCATION_EXPORTS = new Set(
  [...providerInvocationSource.matchAll(/export\s+async\s+function\s+(completeProvider\w+)\b/g)]
    .map((match) => match[1]!),
);
const cliExecutorName = String.raw`(?:SandboxRunnerCliCommandExecutor)`;
const agentInvocationExportName = String.raw`(?:executeManagedApiNoToolAdapter|executeVendorCliAdapter|executeRuntimeHost)`;

function importsCliTransportConsumer(source: string): boolean {
  const cliModule = String.raw`[^"']*sandboxRunner/client`;
  if (new RegExp(String.raw`import\s*\{[^}]*\b${cliExecutorName}\b[^}]*\}\s*from\s*["']${cliModule}["']`, "s").test(source)) {
    return true;
  }
  if (new RegExp(String.raw`import\s*\*\s*as\s+\w+\s*from\s*["']${cliModule}["']`).test(source)) {
    return true;
  }
  return new RegExp(String.raw`(?:import\s*\(|require\s*\()\s*["']${cliModule}["']\s*\)`).test(source);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function providerCallsites(source: string, relativeFile: string): string[] {
  const localHelpers = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)) {
    if (!isProviderInvocationModule(match[2] ?? "")) continue;
    for (const binding of (match[1] ?? "").split(",")) {
      const parsed = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(binding.trim());
      if (!parsed) continue;
      const exported = parsed[1]!;
      const local = parsed[2] ?? exported;
      if (PROVIDER_INVOCATION_EXPORTS.has(exported)) localHelpers.set(local, exported);
    }
  }
  for (const match of source.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g)) {
    if (isProviderInvocationModule(match[2] ?? "")) namespaces.add(match[1]!);
  }
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:import\s*\(|require\s*\()\s*["']([^"']+)["']\s*\)/g)) {
    if (isProviderInvocationModule(match[2] ?? "")) namespaces.add(match[1]!);
  }
  for (const namespace of namespaces) {
    const destructuringPattern = new RegExp(
      String.raw`(?:const|let)\s*\{([^}]*)\}\s*=\s*${namespace}\s*;`,
      "g",
    );
    for (const match of source.matchAll(destructuringPattern)) {
      for (const binding of (match[1] ?? "").split(",")) {
        const parsed = /^(\w+)(?:\s*:\s*(\w+))?$/.exec(binding.trim());
        if (parsed && PROVIDER_INVOCATION_EXPORTS.has(parsed[1]!)) {
          localHelpers.set(parsed[2] ?? parsed[1]!, parsed[1]!);
        }
      }
    }
  }
  let discoveredAlias = true;
  while (discoveredAlias) {
    discoveredAlias = false;
    for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)(?:\.bind\s*\([^;]*\))?\s*;/g)) {
      const alias = match[1]!;
      const target = localHelpers.get(match[2]!);
      if (target && !localHelpers.has(alias)) {
        localHelpers.set(alias, target);
        discoveredAlias = true;
      }
    }
  }
  const ordinals = new Map<string, number>();
  const calls: Array<{ helper: string; position: number }> = [];
  for (const [local, helper] of localHelpers) {
    const callPattern = new RegExp(String.raw`\b${local}\s*(?:\?\.)?\s*\(`, "g");
    for (const match of source.matchAll(callPattern)) {
      calls.push({ helper, position: match.index });
    }
  }
  for (const namespace of namespaces) {
    const callPattern = new RegExp(
      String.raw`\b${namespace}(?:\.|\?\.|\[\s*["'])(${[...PROVIDER_INVOCATION_EXPORTS].join("|")})(?:["']\s*\])?\s*(?:\?\.)?\s*\(`,
      "g",
    );
    for (const match of source.matchAll(callPattern)) {
      calls.push({ helper: match[1]!, position: match.index });
    }
  }
  const directDynamicCall = new RegExp(
    String.raw`(?:\(\s*)?(?:await\s+)?(?:import\s*\(|require\s*\()\s*["']([^"']+)["']\s*\)\s*\)?\.(${[...PROVIDER_INVOCATION_EXPORTS].join("|")})\s*\(`,
    "g",
  );
  for (const match of source.matchAll(directDynamicCall)) {
    if (isProviderInvocationModule(match[1] ?? "")) {
      calls.push({ helper: match[2]!, position: match.index });
    }
  }
  return calls.sort((left, right) => left.position - right.position).map(({ helper }) => {
    const ordinal = (ordinals.get(helper) ?? 0) + 1;
    ordinals.set(helper, ordinal);
    return `${relativeFile}#${helper}:${ordinal}`;
  });
}

function isProviderInvocationModule(modulePath: string): boolean {
  return /(?:\/invocation\/invocation|\/providers(?:\/index)?|^\.\.?\/providers)$/.test(modulePath);
}

function locallyReExportsProviderInvocation(source: string): boolean {
  const importedLocals = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)) {
    if (!isProviderInvocationModule(match[2] ?? "")) continue;
    for (const binding of (match[1] ?? "").split(",")) {
      const parsed = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(binding.trim());
      if (parsed && PROVIDER_INVOCATION_EXPORTS.has(parsed[1]!)) {
        importedLocals.add(parsed[2] ?? parsed[1]!);
      }
    }
  }
  return [...source.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/gs)].some((match) =>
    [...importedLocals].some((local) => new RegExp(String.raw`\b${local}\b`).test(match[1] ?? "")));
}

function cliRunCommandCallsites(source: string, relativeFile: string): string[] {
  if (!importsCliTransportConsumer(source)) return [];
  return [...source.matchAll(/\.runCommand\s*\(/g)]
    .map((_, index) => `${relativeFile}#runCommand:${index + 1}`);
}

function importsProviderInvocation(source: string): boolean {
  const providerModule = String.raw`[^"']*(?:\/invocation\/invocation|\/providers(?:\/index)?|\.\.?\/providers)`;
  const namedImports = new RegExp(
    String.raw`import\s*\{([^}]*)\}\s*from\s*["']${providerModule}["']`,
    "gs",
  );
  for (const namedImport of source.matchAll(namedImports)) {
    if ([...PROVIDER_INVOCATION_EXPORTS].some((name) =>
      new RegExp(String.raw`\b${name}\b`).test(namedImport[1] ?? ""))) return true;
  }
  const namedReExports = new RegExp(
    String.raw`export\s*\{([^}]*)\}\s*from\s*["']${providerModule}["']`,
    "gs",
  );
  for (const namedReExport of source.matchAll(namedReExports)) {
    if ([...PROVIDER_INVOCATION_EXPORTS].some((name) =>
      new RegExp(String.raw`\b${name}\b`).test(namedReExport[1] ?? ""))) return true;
  }
  if (new RegExp(String.raw`export\s*\*\s*from\s*["']${providerModule}["']`).test(source)) {
    return true;
  }
  if (new RegExp(String.raw`import\s*\*\s*as\s+\w+\s*from\s*["']${providerModule}["']`).test(source)) {
    return true;
  }
  if (new RegExp(String.raw`(?:import\s*\(|require\s*\()\s*["']${providerModule}["']\s*\)`).test(source)) {
    return true;
  }
  return false;
}

function importsAgentInvocation(source: string, relativeFile: string): boolean {
  const namedPatterns = [
    /import\s*\{[^}]*\bexecuteManagedApiNoToolAdapter\b[^}]*\}\s*from\s*["'][^"']*managedApiAdapter["']/s,
    /import\s*\{[^}]*\bexecuteVendorCliAdapter\b[^}]*\}\s*from\s*["'][^"']*vendorCliAdapter["']/s,
    /import\s*\{[^}]*\bexecuteRuntimeHost\b[^}]*\}\s*from\s*["'][^"']*(?:runtimeHost|\.\/service)["']/s,
  ];
  if (namedPatterns.some((pattern) => pattern.test(source))) return true;
  const modulePattern = String.raw`[^"']*(?:managedApiAdapter|vendorCliAdapter|runtimeHost)`;
  if (new RegExp(String.raw`import\s*\*\s*as\s+\w+\s*from\s*["']${modulePattern}["']`).test(source)) return true;
  if (new RegExp(String.raw`(?:import\s*\(|require\s*\()\s*["']${modulePattern}["']\s*\)`).test(source)) return true;
  if (relativeFile.startsWith("runtimeHost/")
    && /(?:import\s*\*\s*as\s+\w+\s*from|(?:import|require)\s*\()\s*["']\.\/service["']/.test(source)) {
    return true;
  }
  return false;
}

function agentInvocationCallsites(source: string, relativeFile: string): string[] {
  const localHelpers = new Map<string, string>();
  const namespaces = new Set<string>();
  const exportedHelpers = [
    "executeManagedApiNoToolAdapter",
    "executeVendorCliAdapter",
    "executeRuntimeHost",
  ];
  const helperPattern = exportedHelpers.join("|");
  const isAgentModule = (modulePath: string) =>
    /(?:managedApiAdapter|vendorCliAdapter|runtimeHost|\.\/service)$/.test(modulePath);

  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)) {
    if (!isAgentModule(match[2] ?? "")) continue;
    for (const binding of (match[1] ?? "").split(",")) {
      const parsed = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(binding.trim());
      if (parsed && exportedHelpers.includes(parsed[1]!)) {
        localHelpers.set(parsed[2] ?? parsed[1]!, parsed[1]!);
      }
    }
  }
  for (const match of source.matchAll(/import\s*\*\s*as\s+(\w+)\s*from\s*["']([^"']+)["']/g)) {
    if (isAgentModule(match[2] ?? "")) namespaces.add(match[1]!);
  }
  for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:import\s*\(|require\s*\()\s*["']([^"']+)["']\s*\)/g)) {
    if (isAgentModule(match[2] ?? "")) namespaces.add(match[1]!);
  }

  const calls: Array<{ helper: string; position: number }> = [];
  for (const [local, helper] of localHelpers) {
    for (const match of source.matchAll(new RegExp(String.raw`\b${local}\s*(?:\?\.)?\s*\(`, "g"))) {
      calls.push({ helper, position: match.index });
    }
  }
  for (const namespace of namespaces) {
    const pattern = new RegExp(
      String.raw`\b${namespace}(?:\.|\?\.|\[\s*["'])(${helperPattern})(?:["']\s*\])?\s*(?:\?\.)?\s*\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) calls.push({ helper: match[1]!, position: match.index });
  }

  const ordinals = new Map<string, number>();
  return calls.sort((left, right) => left.position - right.position).map(({ helper }) => {
    const ordinal = (ordinals.get(helper) ?? 0) + 1;
    ordinals.set(helper, ordinal);
    return `${relativeFile}#${helper}:${ordinal}`;
  });
}

function reExportsAgentInvocation(source: string): boolean {
  const agentModule = String.raw`[^"']*(?:managedApiAdapter|vendorCliAdapter|runtimeHost|\.\/service)`;
  if (new RegExp(
    String.raw`export\s*\{[^}]*\b${agentInvocationExportName}\b[^}]*\}\s*from\s*["']${agentModule}["']`,
    "s",
  ).test(source)) return true;
  if (new RegExp(String.raw`export\s*\*\s*from\s*["']${agentModule}["']`).test(source)) return true;

  const importedLocals = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)) {
    if (!new RegExp(`(?:managedApiAdapter|vendorCliAdapter|runtimeHost|\\./service)$`).test(match[2] ?? "")) continue;
    for (const binding of (match[1] ?? "").split(",")) {
      const parsed = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(binding.trim());
      if (parsed && new RegExp(`^${agentInvocationExportName}$`).test(parsed[1]!)) {
        importedLocals.add(parsed[2] ?? parsed[1]!);
      }
    }
  }
  return [...source.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/gs)].some((match) =>
    [...importedLocals].some((local) => new RegExp(String.raw`\b${local}\b`).test(match[1] ?? "")));
}

describe("Runtime Context invocation entrypoint inventory", () => {
  it("routes every managed conversation producer to the Runtime Context Gateway", () => {
    expect(MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY).toEqual([
      expect.objectContaining({
        source: "agents/routes.ts",
        executionMode: "conversation_lightweight.v1",
        targetBoundary: "runtime_context_gateway",
      }),
      expect.objectContaining({
        source: "agentGroups/service.ts",
        executionMode: "room_conversation.v1",
        targetBoundary: "runtime_context_gateway",
      }),
    ]);
    for (const entry of MANAGED_CONVERSATION_ENTRYPOINT_INVENTORY) {
      const source = readFileSync(join(modulesRoot, entry.source), "utf8");
      expect(source).toContain(entry.executionMode);
      expect(entry.targetBoundary).toBe("runtime_context_gateway");
    }
    const orchestration = readFileSync(
      join(modulesRoot, "runs", "orchestrationService.ts"),
      "utf8",
    );
    expect(orchestration).toMatch(/if \(this\.runtimeContextGateway\) \{/);
    expect(orchestration).not.toMatch(
      /if \(this\.runtimeContextGateway\s*&&[^)]*(?:chat|conversation|room)/i,
    );
  });

  it("registers every direct Provider invocation callsite", () => {
    const discovered = tsFiles(modulesRoot)
      .filter((file) => relative(modulesRoot, file) !== "providers/invocation/invocation.ts")
      .flatMap((file) => providerCallsites(readFileSync(file, "utf8"), relative(modulesRoot, file)))
      .sort();
    const registered = RUNTIME_INVOCATION_INVENTORY
      .filter((item) => item.entrypoint.includes("#completeProvider"))
      .map((item) => item.entrypoint)
      .sort();
    expect(registered).toEqual(discovered);
  });

  it("detects Provider facade bypasses across supported import syntax", () => {
    expect([...PROVIDER_INVOCATION_EXPORTS]).toContain("completeProviderMessages");
    expect(importsProviderInvocation('import { completeProviderText as complete } from "../providers";')).toBe(true);
    expect(importsProviderInvocation('import * as providers from "../providers";')).toBe(true);
    expect(importsProviderInvocation('const providers = await import("../providers");')).toBe(true);
    expect(importsProviderInvocation('const providers = require("../providers");')).toBe(true);
    expect(importsProviderInvocation('export { completeProviderText as complete } from "../providers";')).toBe(true);
    expect(importsProviderInvocation('export * from "../providers";')).toBe(true);
    expect(importsProviderInvocation('import { listProviderConfigs } from "../providers";')).toBe(false);
    expect(providerCallsites(
      'import { completeProviderText as invoke } from "../providers"; await invoke(store, spaceId, input);',
      "newTask.ts",
    )).toEqual(["newTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'const providers = await import("../providers"); await providers.completeProviderText(store, spaceId, input);',
      "dynamicTask.ts",
    )).toEqual(["dynamicTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'require("../providers").completeProviderText(store, spaceId, input);',
      "requiredTask.ts",
    )).toEqual(["requiredTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'import { completeProviderText } from "../providers"; const invoke = completeProviderText; await invoke(store, spaceId, input);',
      "indirectTask.ts",
    )).toEqual(["indirectTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'import { completeProviderText } from "../providers"; const invoke = completeProviderText.bind(null, store); await invoke(spaceId, input);',
      "boundTask.ts",
    )).toEqual(["boundTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'import * as providers from "../providers"; await providers["completeProviderText"]?.(store, spaceId, input);',
      "bracketTask.ts",
    )).toEqual(["bracketTask.ts#completeProviderText:1"]);
    expect(providerCallsites(
      'import * as providers from "../providers"; const { completeProviderText: invoke } = providers; await invoke(store, spaceId, input);',
      "destructuredTask.ts",
    )).toEqual(["destructuredTask.ts#completeProviderText:1"]);
  });

  it("registers every Provider invocation re-export facade", () => {
    const discovered = tsFiles(modulesRoot)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gs)]
          .some((match) => isProviderInvocationModule(match[2] ?? "")
            && [...PROVIDER_INVOCATION_EXPORTS].some((helper) =>
              new RegExp(String.raw`\b${helper}\b`).test(match[1] ?? "")))
          || [...source.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)]
            .some((match) => isProviderInvocationModule(match[1] ?? ""))
          || locallyReExportsProviderInvocation(source);
      })
      .map((file) => relative(modulesRoot, file))
      .sort();
    const registered = RUNTIME_INVOCATION_INVENTORY
      .filter((item) => item.classification === "provider_facade" && item.entrypoint === item.source)
      .map((item) => item.source)
      .sort();
    expect(registered).toEqual(discovered);
    expect(discovered).toEqual(["providers/index.ts"]);
    expect(locallyReExportsProviderInvocation(
      'import { completeProviderText as invoke } from "../providers"; export { invoke };',
    )).toBe(true);
  });

  it("classifies mixed Provider route callsites independently", () => {
    const routes = RUNTIME_INVOCATION_INVENTORY.filter(
      (item) => item.source === "providers/commands/routes.ts",
    );
    expect(routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entrypoint: "providers/commands/routes.ts#completeProviderChat:1",
        classification: "bounded_provider_task",
        targetBoundary: "provider_task",
      }),
      expect.objectContaining({
        entrypoint: "providers/commands/routes.ts#completeProviderText:1",
        classification: "provider_facade",
        targetBoundary: "provider_task",
      }),
    ]));
    const source = readFileSync(join(modulesRoot, "providers", "commands", "routes.ts"), "utf8");
    expect(source).toContain('app.post("/api/v1/providers/:configId/test"');
    expect(source).not.toContain('app.post("/api/v1/providers/chat"');
    expect(source).toContain('app.post("/internal/providers-credentials/providers/complete-text"');
  });

  it("registers every concrete Provider transport", () => {
    const discovered = tsFiles(join(modulesRoot, "providers"))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        const relativeFile = relative(modulesRoot, file);
        return (relativeFile.startsWith("providers/invocation/")
            && /export\s+async\s+function\s+completeProvider\w+\b/.test(source))
          || (relativeFile.startsWith("providers/proxy/")
            && /createServer\s*\(/.test(source));
      })
      .map((file) => relative(modulesRoot, file))
      .sort();
    const registered = RUNTIME_INVOCATION_INVENTORY
      .filter((item) => item.classification === "provider_transport")
      .map((item) => item.source)
      .sort();
    expect(registered).toEqual(discovered);
  });

  it("registers every Agent runtime-host and CLI adapter invoker", () => {
    const discovered = tsFiles(modulesRoot)
      .flatMap((file) => agentInvocationCallsites(
        readFileSync(file, "utf8"),
        relative(modulesRoot, file),
      ))
      .sort();
    const entries = new Map(RUNTIME_INVOCATION_INVENTORY.map((item) => [item.entrypoint, item]));
    const invalid = discovered.filter((entrypoint) => {
      const item = entries.get(entrypoint);
      return !item || !(
        (item.classification === "agent_task_gateway" && item.targetBoundary === "runtime_context_gateway")
        || (item.classification === "agent_task_renderer" && item.targetBoundary === "delivery_renderer")
      );
    });
    expect(invalid).toEqual([]);
    expect(discovered).toEqual([
      "runs/managedApiAdapter.ts#executeRuntimeHost:1",
      "runs/orchestrationService.ts#executeManagedApiNoToolAdapter:1",
      "runs/orchestrationService.ts#executeVendorCliAdapter:1",
      "runtimeHost/routes.ts#executeRuntimeHost:1",
    ]);
  });

  it("detects Agent runtime bypasses across supported import syntax", () => {
    expect(importsAgentInvocation('import * as host from "../runtimeHost";', "runs/newAdapter.ts")).toBe(true);
    expect(importsAgentInvocation('const host = await import("../runtimeHost");', "runs/newAdapter.ts")).toBe(true);
    expect(importsAgentInvocation('const host = require("../runtimeHost");', "runs/newAdapter.ts")).toBe(true);
    expect(importsAgentInvocation('import * as host from "./service";', "runtimeHost/routes.ts")).toBe(true);
    expect(agentInvocationCallsites(
      'import { executeRuntimeHost as invoke } from "../runtimeHost"; await invoke(config, input);',
      "runs/newAdapter.ts",
    )).toEqual(["runs/newAdapter.ts#executeRuntimeHost:1"]);
  });

  it("allows only the canonical Agent invocation re-export facade", () => {
    const discovered = tsFiles(modulesRoot)
      .filter((file) => reExportsAgentInvocation(readFileSync(file, "utf8")))
      .map((file) => relative(modulesRoot, file))
      .sort();
    expect(discovered).toEqual(["runtimeHost/index.ts"]);
    expect(reExportsAgentInvocation(
      'export { executeRuntimeHost as runAgent } from "../runtimeHost";',
    )).toBe(true);
    expect(reExportsAgentInvocation(
      'import { executeRuntimeHost as runAgent } from "../runtimeHost"; export { runAgent };',
    )).toBe(true);
  });

  it("classifies every local CLI transport consumer at its owning boundary", () => {
    const discovered = tsFiles(modulesRoot)
      .filter((file) => relative(modulesRoot, file) !== "runs/localCliExecution.ts")
      .flatMap((file) => cliRunCommandCallsites(readFileSync(file, "utf8"), relative(modulesRoot, file)))
      .sort();
    const entries = new Map(RUNTIME_INVOCATION_INVENTORY.map((item) => [item.entrypoint, item]));
    const invalid = discovered.filter((entrypoint) => {
      const item = entries.get(entrypoint);
      return !item || !(
        (item.classification === "agent_task_renderer" && item.targetBoundary === "delivery_renderer")
        || (item.classification === "bounded_cli_task" && item.targetBoundary === "provider_task")
      );
    });
    expect(invalid).toEqual([]);
  });

  it("detects local CLI consumers across supported import syntax", () => {
    expect(importsCliTransportConsumer('import { SandboxRunnerCliCommandExecutor as Executor } from "../sandboxRunner/client";')).toBe(true);
    expect(importsCliTransportConsumer('import * as cli from "../sandboxRunner/client";')).toBe(true);
    expect(importsCliTransportConsumer('const cli = await import("../sandboxRunner/client");')).toBe(true);
    expect(importsCliTransportConsumer('const cli = require("../sandboxRunner/client");')).toBe(true);
    expect(cliRunCommandCallsites(
      'import { SandboxRunnerCliCommandExecutor } from "../sandboxRunner/client"; await executor.runCommand({});',
      "newAdapter.ts",
    ))
      .toEqual(["newAdapter.ts#runCommand:1"]);
    expect(cliRunCommandCallsites("await unrelated.runCommand({});", "unrelated.ts")).toEqual([]);
  });

  it("registers every concrete Agent delivery renderer", () => {
    const rendererDefinition = /export\s+async\s+function\s+execute(?:ManagedApiNoTool|VendorCli)Adapter\b/;
    const discovered = tsFiles(modulesRoot)
      .filter((file) => rendererDefinition.test(readFileSync(file, "utf8")))
      .map((file) => relative(modulesRoot, file))
      .sort();
    const registered = [...new Set(RUNTIME_INVOCATION_INVENTORY
      .filter((item) => item.classification === "agent_task_renderer")
      .map((item) => item.source))]
      .sort();
    expect(registered).toEqual(discovered);
  });

  it("registers every concrete local CLI process transport", () => {
    const discovered = tsFiles(modulesRoot)
      .filter((file) => /spawn\(input\.command\[0\]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(modulesRoot, file))
      .sort();
    const registered = RUNTIME_INVOCATION_INVENTORY
      .filter((item) => item.classification === "agent_task_transport")
      .map((item) => item.source)
      .sort();
    expect(registered).toEqual(discovered);
  });

  it("keeps every registered entrypoint unique and source real", () => {
    const entrypoints = RUNTIME_INVOCATION_INVENTORY.map((item) => item.entrypoint);
    expect(new Set(entrypoints).size).toBe(entrypoints.length);
    for (const item of RUNTIME_INVOCATION_INVENTORY) {
      expect(existsSync(join(modulesRoot, item.source)), item.source).toBe(true);
    }
  });

  it("separates Agent task context from bounded owning-domain Provider tasks", () => {
    const bounded = RUNTIME_INVOCATION_INVENTORY.filter(
      (item) => item.classification === "bounded_provider_task",
    );
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.every((item) => item.targetBoundary === "provider_task")).toBe(true);
    expect(
      RUNTIME_INVOCATION_INVENTORY.some(
        (item) => item.classification === "agent_task_gateway" && item.targetBoundary === "runtime_context_gateway",
      ),
    ).toBe(true);
  });

  it("exposes only the Runtime Context public port outside its module", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(modulesRoot)) {
      if (file.includes(`${join("modules", "runtimeContext")}`)) continue;
      const text = readFileSync(file, "utf8");
      if (/runtimeContext\/(contracts|invocationInventory)/.test(text)) {
        offenders.push(relative(modulesRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
