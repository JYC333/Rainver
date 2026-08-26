import type { ResearchCompiledQuery, ResearchProviderKey } from "@agent-space/protocol";
import { buildArxivQueryUrl, type ArxivQueryConfig } from "../connectors/arxiv.js";
import { HttpError } from "../../routeUtils/common.js";
import {
  sourceConnectorRegistry,
  type NormalizedSourceItem,
  type RequestSpec,
  type SourceConnectorHandler,
} from "../catalog/sourceConnectorRegistry.js";

export type SearchExecutionHandler = Pick<
  SourceConnectorHandler,
  "buildScanRequest" | "buildBackfillRequest" | "parseResponse" | "parseCursor" | "prepareRequest"
>;

export interface ResearchSearchExecutionInput {
  compiledQuery: ResearchCompiledQuery;
  cursor?: Record<string, unknown>;
  window?: Record<string, unknown>;
}

/** Execution-only bridge. It never accepts semantic intent and never compiles. */
export class SearchExecutionAdapter {
  buildScanRequest(input: ResearchSearchExecutionInput): RequestSpec {
    assertExecutableQuery(input.compiledQuery);
    const handler = this.handler(input.compiledQuery.provider_key);
    return handler.buildScanRequest(channelShape(input.compiledQuery), input.cursor ?? {});
  }

  buildBackfillRequest(input: ResearchSearchExecutionInput): RequestSpec {
    assertExecutableQuery(input.compiledQuery);
    const handler = this.handler(input.compiledQuery.provider_key);
    return handler.buildBackfillRequest(channelShape(input.compiledQuery), input.window ?? {}, input.cursor ?? {});
  }

  parseResponse(providerKey: ResearchProviderKey, response: string): NormalizedSourceItem[] {
    return this.handler(providerKey).parseResponse(response);
  }

  parseCursor(providerKey: ResearchProviderKey, response: string): Record<string, unknown> {
    return this.handler(providerKey).parseCursor?.(response) ?? {};
  }

  async prepareRequest(providerKey: ResearchProviderKey): Promise<void> {
    await this.handler(providerKey).prepareRequest?.();
  }

  private handler(providerKey: ResearchProviderKey): SearchExecutionHandler {
    return sourceConnectorRegistry.get(connectorKey(providerKey));
  }
}

export function connectorKey(providerKey: ResearchProviderKey): string {
  if (providerKey === "arxiv") return "arxiv_api";
  if (providerKey === "openalex") return "openalex_api";
  if (providerKey === "semantic_scholar") return "semantic_scholar_api";
  return "brave_web_search_api";
}

function channelShape(compiled: ResearchCompiledQuery): { endpoint_url: string | null; compiled_query: unknown } {
  return {
    endpoint_url: compiled.provider_key === "arxiv"
      ? buildArxivQueryUrl(compiled.query as unknown as ArxivQueryConfig)
      : null,
    compiled_query: compiled.query,
  };
}

function assertExecutableQuery(compiled: ResearchCompiledQuery): void {
  const query = compiled.query;
  const field = compiled.provider_key === "arxiv"
    ? "search_query"
    : compiled.provider_key === "openalex"
      ? "search"
      : compiled.provider_key === "semantic_scholar"
        ? "query"
        : "q";
  if (typeof query[field] !== "string" || !query[field].trim()) {
    throw new HttpError(422, `Compiled ${compiled.provider_key} query requires query.${field}`);
  }
}
