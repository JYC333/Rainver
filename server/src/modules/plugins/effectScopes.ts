import { runOperationWork } from '../../db/operationTransaction.js';
import type { PluginScope } from '@rainver/protocol';
interface ScopeState {
  scope: PluginScope;
  controller: AbortController;
  callbacks: (() => Promise<void> | void)[];
  cleanup?: Promise<void>;
}
/** Per-config cooperative resource lifecycle, not a worker or scheduler engine. */
export class PluginEffectScopes {
  constructor(private readonly cleanupTimeoutMs = 3000) {}
  private readonly states = new Map<string, ScopeState>();
  private readonly drains = new Map<string, {id: string; scope: PluginScope; work: Promise<void>}>();
  private readonly blocked = new Map<string, {
    id: string;
    predicate: (scope: PluginScope) => boolean;
  }>();
  private readonly closing = new Map<string, PluginScope>();
  private key(id: string, s: PluginScope) {
    return `${id}:${s.spaceId}:${s.userId}`;
  }
  enter(id: string, scope: PluginScope) {
    const key = this.key(id, scope);
    if (this.drains.has(key) || this.closing.has(key) || [...this.blocked.values()].some(b => b.id === id && b.predicate(scope))) throw new Error('Plugin scope is closing');
    let state = this.states.get(key);
    if (!state) {
      state = {
        scope,
        controller: new AbortController(),
        callbacks: []
      };
      this.states.set(key, state);
    }
    const current = state;
    return {
      signal: state.controller.signal,
      dispose: () => this.waitForCleanup([this.startDrain(id, key, current)]),
      onDispose: (fn: () => Promise<void> | void) => {
        let work: Promise<void> | undefined;
        const once = () => work ??= runOperationWork(async () => fn());
        current.callbacks.push(once);
        return once;
      }
    };
  }
  async closeWhere(id: string, predicate: (scope: PluginScope) => boolean, token = `${id}:shutdown`): Promise<void> {
    this.blockWhere(id, predicate, token);
    const work: Promise<void>[] = [];
    for (const [key, state] of this.states) {
      if (!key.startsWith(id + ':') || !predicate(state.scope)) continue;
      this.closing.set(key, state.scope);
      state.controller.abort();
      work.push(this.startDrain(id, key, state));
    }
    await this.waitForCleanup(work);
  }
  private startDrain(id: string, key: string, state: ScopeState): Promise<void> {
    if (state.cleanup) return state.cleanup;
    const cleanup = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        for (const dispose of [...state.callbacks].reverse()) try {
          await dispose();
        } catch (e) {
          errors.push(e);
        }
        if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
      } finally {
        this.states.delete(key);
        this.drains.delete(key);
      }
    });
    state.cleanup = cleanup;
    this.drains.set(key, {id, scope:state.scope, work:cleanup});
    return cleanup;
  }
  private async waitForCleanup(work: Promise<void>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(work),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Plugin cleanup timed out')), this.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  hasPendingCleanup(id: string, predicate: (scope: PluginScope) => boolean): boolean {
    return [...this.drains.values()].some(d => d.id === id && predicate(d.scope));
  }
  /** Admission-only hold, used to retain a committed disable after cleanup. */
  blockWhere(id: string, predicate: (scope: PluginScope) => boolean, token: string): void {
    this.blocked.set(token, {
      id,
      predicate
    });
  }
  reopen(id: string, scope: PluginScope) {
    this.closing.delete(this.key(id, scope));
  }
  reopenWhere(id: string, predicate: (scope: PluginScope) => boolean, token?: string) {
    if (token) this.blocked.delete(token);else for (const [key, b] of this.blocked) if (b.id === id) this.blocked.delete(key);
    for (const [key, scope] of this.closing) if (key.startsWith(id + ':') && predicate(scope)) this.closing.delete(key);
  }
  async closeAll() {
    const errors: unknown[] = [];
    for (const key of [...new Set([...this.states.keys()].map(x => x.split(':')[0]!))]) try {
      await this.closeWhere(key, () => true);
    } catch (e) {
      errors.push(e);
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin scope cleanup failed');
  }
}
