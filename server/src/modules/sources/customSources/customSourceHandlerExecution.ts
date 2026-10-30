import * as protocol from "@rainver/protocol";
import type {
  CustomSourceHandlerInput,
  CustomSourcePolicyEnvelope,
} from "@rainver/protocol";
import { HttpError } from "../../routeUtils/common.js";
import type { CustomSourceFetchCredential } from "./customSourceEndpointFetch.js";
import type { OutboundGuard } from "../outboundUrlSafety.js";
import type { HandlerVersionRow } from "./customSourceHandlerRepository.js";
import { runCustomSourcePipeline } from "./customSourcePipelineInterpreter.js";
import {
  evaluateCustomSourceExecutionBlockReason,
  type SourceExecutionResult,
  type SourceExecutionSettings,
} from "../sourceExecutionPolicy.js";

/**
 * Shared dispatch for retained handler tests and scans. Legacy arbitrary code
 * is refused before artifact access; declarative pipelines retain the reviewed
 * interpreter and existing policy gates. Goal code uses its separate isolated
 * Host executor and never falls back here.
 */
export async function executeCustomSourceHandler(
  settings: SourceExecutionSettings,
  args: {
    version: HandlerVersionRow;
    policyEnvelope: CustomSourcePolicyEnvelope;
    handlerInput: CustomSourceHandlerInput;
    /** Resolved by the caller only after admission, for declarative live fetches. */
    credential?: CustomSourceFetchCredential | null;
    /** The outbound boundary the pipeline interpreter's live fetches go through. */
    guard?: OutboundGuard;
  },
): Promise<SourceExecutionResult> {
  const blockReason = evaluateCustomSourceExecutionBlockReason(settings, args.policyEnvelope);
  if (blockReason) return { status: "blocked", reason: blockReason };

  const manifest = (args.version.manifest_json ?? {}) as { pipeline?: unknown };
  const parsed = protocol.CustomSourcePipelineDefinitionSchema.safeParse(manifest.pipeline);
  if (!parsed.success) throw new HttpError(422, "Handler version has no valid pipeline definition");
  return runCustomSourcePipeline(settings, {
    policyEnvelope: args.policyEnvelope,
    handlerInput: args.handlerInput,
    pipeline: parsed.data,
    credential: args.credential,
    ...(args.guard ? { guard: args.guard } : {}),
  });
}
