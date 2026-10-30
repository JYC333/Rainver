/**
 * Run recovery has one owner and never occupies a business job lane. Passes
 * never overlap: the next is scheduled only after the previous settles. A pass
 * that runs past `stallAfterMs` is reported once (it is not abandoned, and no
 * second pass starts beside it), so a hung step is visible rather than silent.
 */
export class RunRecoveryLoop {
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** When the last pass finished without throwing (null before the first). */
  lastCompletedAt: Date | null = null;

  constructor(
    private readonly recover: () => Promise<void>,
    private readonly intervalMs: number,
    private readonly reportError: (error: unknown) => void,
    private readonly stall?: { afterMs: number; report: (elapsedMs: number) => void },
  ) {}

  start(): void {
    if (this.stopped || this.active || this.timer) return;
    const startedAt = Date.now();
    const watchdog = this.stall
      ? setTimeout(() => this.stall!.report(Date.now() - startedAt), this.stall.afterMs)
      : null;
    watchdog?.unref?.();
    this.active = Promise.resolve().then(() => this.recover())
      .then(() => { this.lastCompletedAt = new Date(); }, error => this.reportError(error))
      .finally(() => {
        if (watchdog) clearTimeout(watchdog);
        this.active = null;
        if (!this.stopped) {
          this.timer = setTimeout(() => { this.timer = null; this.start(); }, this.intervalMs);
          this.timer.unref?.();
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }
}
