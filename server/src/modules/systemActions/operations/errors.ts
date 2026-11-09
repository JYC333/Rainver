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
