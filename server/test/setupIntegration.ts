import type { TestProject } from "vitest/node";

// Global setups run in the coordinator process. Both integration projects
// inherit the root's provided context, and must share one setup even when
// container reuse is disabled in CI. Pure projects never import the heavy graph.
const key = Symbol.for("rainver.test.integrationSetup");
type Setup = { users: number; ready: Promise<() => Promise<void>> };
const coordinator = globalThis as typeof globalThis & { [key]?: WeakMap<TestProject, Setup> };
const setups = coordinator[key] ??= new WeakMap<TestProject, Setup>();

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = project.vitest.getRootProject();
  let shared = setups.get(root);
  if (!shared) {
    shared = {
      users: 0,
      ready: import("./setupOfficialPlugins.js").then(({ default: start }) => start(root)),
    };
    setups.set(root, shared);
  }
  shared.users++;
  const stop = await shared.ready;
  return async () => {
    if (--shared.users === 0) {
      setups.delete(root);
      await stop();
    }
  };
}
