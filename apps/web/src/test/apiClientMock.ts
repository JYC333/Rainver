/**
 * The client's error class, for `vi.mock('.../api/client')` factories.
 *
 * Components branch on `error instanceof ApiRequestError`, so a mock of the
 * client has to supply a real class with the same fields — and one class, not
 * a copy per test file, or the copies drift from the client and from each
 * other. Use it from a factory with `await import(...)`; factories are hoisted
 * above top-level imports.
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}
