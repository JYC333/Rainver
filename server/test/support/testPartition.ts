import { describe as vitestDescribe, it as vitestIt } from "vitest";

/**
 * Splits one long test suite across several `*.test.ts` entry files.
 *
 * A file's tests run one after another, so the slowest file is a floor under
 * the whole run no matter how many workers there are. A suite that has grown
 * past that floor lives in `<name>.suite.ts` as `define…Suite(filename,
 * partition)`, and each entry file registers one part of it against its own
 * database: `defineXSuite(import.meta.filename, partitionTests(0, 3))`.
 *
 * Test registrations (`it`, `it.each`, `it.for`, `it.skipIf`, ...) are dealt
 * round-robin in registration order, so every part keeps the suite's relative
 * order and its file-level hooks. A `describe` named in `routes` is registered
 * only in the listed parts, and its tests are dealt among those parts alone.
 * Any other `describe` is transparent: its tests take the enclosing turn
 * order. A transparent `describe` that would end up empty in a part fails
 * loudly, because Vitest rejects an empty suite; route it instead.
 */
export interface TestPartition {
  it: typeof vitestIt;
  test: typeof vitestIt;
  describe: typeof vitestDescribe;
}

interface Scope {
  parts: readonly number[];
  turn: { next: number };
}

export function partitionTests(
  part: number,
  parts: number,
  routes: Readonly<Record<string, readonly number[]>> = {},
): TestPartition {
  if (!Number.isInteger(parts) || parts < 1 || !Number.isInteger(part) || part < 0 || part >= parts) {
    throw new Error(`invalid test partition ${part} of ${parts}`);
  }
  const stack: Scope[] = [{ parts: Array.from({ length: parts }, (_, index) => index), turn: { next: 0 } }];
  let registered = 0;

  const take = (): boolean => {
    const scope = stack[stack.length - 1]!;
    const owner = scope.parts[scope.turn.next++ % scope.parts.length];
    if (owner !== part) return false;
    registered += 1;
    return true;
  };

  type Register = (...args: any[]) => unknown;
  // Wraps Vitest's chainable test API at any depth (`it.skipIf(c).for(t)`).
  // A call whose first argument is a test name registers a test and is dealt
  // to a part; any other call (`each(table)`, `skipIf(condition)`) or property
  // returns another chainable, wrapped in turn. Vitest reads modifiers off
  // `this`, so each call keeps the object it was read from as its receiver.
  const chain = (target: Register, receiver: unknown): Register =>
    new Proxy(target, {
      apply(fn, _this, args: unknown[]) {
        if (typeof args[0] === "string" || typeof args[0] === "function") {
          return take() ? Reflect.apply(fn, receiver, args) : undefined;
        }
        const next = Reflect.apply(fn, receiver, args);
        return typeof next === "function" ? chain(next as Register, next) : next;
      },
      get(fn, property) {
        const value = Reflect.get(fn, property, fn);
        return typeof value === "function" ? chain(value as Register, fn) : value;
      },
    });

  const it = chain(vitestIt as unknown as Register, vitestIt);

  const describe = ((name: string, factory: () => void, options?: unknown) => {
    const route = routes[name];
    if (route && !route.includes(part)) return;
    // Vitest collects a nested describe after its parent's factory returns, so
    // a registered child counts as content of the parent; the child checks
    // its own emptiness when its factory runs.
    registered += 1;
    const parent = stack[stack.length - 1]!;
    const scope: Scope = route ? { parts: route, turn: { next: 0 } } : parent;
    return (vitestDescribe as Register)(name, () => {
      stack.push(scope);
      const before = registered;
      try {
        factory();
      } finally {
        stack.pop();
      }
      if (registered === before) {
        throw new Error(`describe "${name}" has no tests in part ${part + 1} of ${parts}; route it to explicit parts`);
      }
    }, options);
  }) as unknown as typeof vitestDescribe;

  const partitioned = it as unknown as typeof vitestIt;
  return { it: partitioned, test: partitioned, describe };
}
