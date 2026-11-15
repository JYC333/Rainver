import { HttpError } from "../routeUtils/common.js";

/**
 * A deterministic refusal the Evolution asset, evaluation, workflow and prompt
 * owners write for the person: stale state, a field or lifecycle rule, a
 * daily limit. Only these owners construct it, with code-authored text that
 * names fields, states or the caller's own ids, so the operation core may
 * return its message. It stays an HttpError for legacy callers and internal
 * Jobs. Any other error from these paths stays internal.
 */
export class EvolutionAssetRefusal extends HttpError {
  constructor(statusCode: 409 | 422 | 429, message: string, responseBody?: unknown) {
    super(statusCode, message, responseBody);
    this.name = "EvolutionAssetRefusal";
  }
}
