import type { OperationErrorCode, OperationErrorBody } from '@rainver/protocol';
export class OperationError extends Error {
  constructor(readonly code: OperationErrorCode, readonly httpStatus: number, readonly retryable = false, readonly domain = 'operations') {
    super(code);
  }
  get statusCode(): number {
    return this.httpStatus;
  }
  body(requestId: string): OperationErrorBody {
    return {
      error: {
        code: this.code,
        domain: this.domain,
        message: this.code.replaceAll('_', ' '),
        metadata: {},
        retryable: this.retryable,
        request_id: requestId
      }
    };
  }
}
/** Only explicitly classified domain failures may be cached. */
export class OperationBusinessError extends OperationError {
  constructor(code: 'operation_conflict' | 'operation_invalid_input', status: 409 | 422, domain: string) {
    super(code, status, false, domain);
  }
}
export const hidden = () => new OperationError('operation_not_found', 404);
/**
 * An explicitly marked domain refusal whose text and structured body were
 * always written for the person (for example a disclosure or sharing
 * confirmation naming who would gain access). Only a domain adapter's
 * classifier constructs one, from its own marked error class; the body is
 * JSON-copied, so no prototype or private field leaks. Cached like any
 * deterministic business failure.
 */
export class OperationRefusal extends OperationBusinessError {
  private readonly detail: string;
  private readonly details: Record<string, unknown>;
  constructor(status: 409 | 422, domain: string, detail: string, details: unknown = {}) {
    super(status === 409 ? 'operation_conflict' : 'operation_invalid_input', status, domain);
    this.detail = detail.slice(0, 2000);
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? JSON.parse(JSON.stringify(details)) as Record<string, unknown> : {};
  }
  override body(requestId: string): OperationErrorBody {
    const body = super.body(requestId);
    body.error.message = this.detail;
    body.error.metadata = this.details;
    return body;
  }
}
/** Classify a marked domain error into a refusal; 400 and 422 are invalid input, 409 a conflict. */
export function markedRefusal(error: {statusCode: number; message: string; responseBody?: unknown}, domain: string): OperationRefusal | undefined {
  if (error.statusCode === 409) return new OperationRefusal(409, domain, error.message, error.responseBody);
  if (error.statusCode === 400 || error.statusCode === 422) return new OperationRefusal(422, domain, error.message, error.responseBody);
  return undefined;
}
