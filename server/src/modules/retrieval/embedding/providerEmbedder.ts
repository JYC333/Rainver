import {
  completeProviderEmbedding,
  type ProviderMeteringContext,
} from "../../providers/invocation/invocation.js";
import type { ProviderCommandStore } from "../../providers/commands/store.js";
import type { RetrievalEgressPolicy } from "../egress/egressPolicy.js";
import { RETRIEVAL_EMBEDDING_TASK } from "./config.js";
import type { RetrievalEmbedder } from "./service.js";

/**
 * Production embedder. Routes through the `retrieval_embedding` provider task
 * policy (ADR 0008 credential channel) with the configured provider as the
 * safety net, exactly like the other auxiliary model tasks.
 */
export class ProviderEmbedder implements RetrievalEmbedder {
  constructor(
    private readonly store: ProviderCommandStore,
    private readonly providerId: string | null,
    private readonly egressPolicy: RetrievalEgressPolicy | null,
    private readonly metering: ProviderMeteringContext,
  ) {}

  async embed(
    spaceId: string,
    texts: string[],
    opts: { dimensions?: number } = {},
  ): Promise<{ vectors: number[][]; model: string }> {
    const result = await completeProviderEmbedding(this.store, spaceId, {
      provider_id: this.providerId,
      inputs: texts,
      task: RETRIEVAL_EMBEDDING_TASK,
      dimensions: opts.dimensions,
      inputType: "document",
      egressPolicy: this.egressPolicy,
      metering: this.metering,
    });
    return { vectors: result.vectors, model: result.model };
  }
}
