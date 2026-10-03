import type { QueryErrorBody, QueryErrorCode } from '../shared/api.js';
export class QueryError extends Error {
  constructor(public code: QueryErrorCode, message: string, public candidates?: Record<string, unknown>[]) { super(message); }
  body(): QueryErrorBody { return { error: { code: this.code, message: this.message, ...(this.candidates ? { candidates: this.candidates } : {}) } }; }
  get statusCode() { return { INVALID_ARGUMENT: 400, NOT_FOUND: 404, AMBIGUOUS: 409, INTERNAL_ERROR: 500 }[this.code]; }
}
export function queryError(error: unknown): QueryError {
  return error instanceof QueryError ? error : new QueryError('INTERNAL_ERROR', '内部错误');
}
