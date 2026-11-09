import { AsyncLocalStorage } from 'node:async_hooks';

type Frame = {
  kind: 'plugin' | 'host';
  parent?: Frame;
  open: boolean;
  pending: number;
  tail: Promise<void>;
};

/** One invocation/connection, with a child queue for each reentrant scope.
 * A transaction owns its savepoint until its callback and children settle.
 * Siblings serialize; descendants reenter through their own queue, not the
 * ancestor queue they already occupy. Host callbacks cannot reenter plugin SQL.
 */
export class PluginInvocationSerial {
  private readonly context = new AsyncLocalStorage<Frame>();

  scope<T>(work: () => Promise<T>): Promise<T> {
    return this.execute('plugin', this.context.getStore(), work);
  }

  run<T>(kind: Frame['kind'], work: () => Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (!parent || !this.live(parent) || parent.kind === 'host') {
      const rejected = Promise.reject<T>(new Error('Plugin invocation port expired or host reentry refused'));
      // Detached callers must not produce an unhandled rejection after expiry.
      void rejected.catch(() => {});
      return rejected;
    }
    parent.pending++;
    const result = parent.tail.then(() => {
      if (!this.live(parent)) throw new Error('Plugin invocation port expired');
      return this.execute(kind, parent, work);
    }).then(value => { parent.pending--; return value; }, error => { parent.pending--; throw error; });
    parent.tail = result.then(() => {}, () => {});
    return result;
  }

  private live(frame: Frame): boolean {
    for (let current: Frame | undefined = frame; current; current = current.parent) {
      if (!current.open) return false;
    }
    return true;
  }

  private execute<T>(kind: Frame['kind'], parent: Frame | undefined, work: () => Promise<T>): Promise<T> {
    const frame: Frame = { kind, parent, open: true, pending: 0, tail: Promise.resolve() };
    return this.context.run(frame, async () => {
      try {
        return await work();
      } finally {
        const detached = frame.pending > 0;
        frame.open = false;
        // Finish already-running SQL/role restoration before outer rollback or
        // close. Queued work sees the closed ancestor and never touches SQL.
        await frame.tail;
        if (detached) throw new Error('Unawaited plugin invocation work refused');
      }
    });
  }
}
