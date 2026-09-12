import * as protocol from "@rainver/protocol";
import type {
  CustomSourceHandlerInput,
  CustomSourcePolicyEnvelope,
} from "@rainver/protocol";
import type { ServerConfig } from "../../../config.js";
import { HttpError, type Queryable } from "../../routeUtils/common.js";
import type { CustomSourceFetchCredential } from "./customSourceEndpointFetch.js";
import type { OutboundGuard } from "../outboundUrlSafety.js";
import type { HandlerVersionRow } from "./customSourceHandlerRepository.js";
import { runCustomSourcePipeline } from "./customSourcePipelineInterpreter.js";
import {
  CustomSourceRunner,
  type CustomSourceRunnerResult,
  type CustomSourceRunnerSettings,
} from "./customSourceRunner.js";
import { resolveStoredArtifactPath } from "./artifactStoragePath.js";

/**
 * Single dispatch point for "execute this (non-blocked) handler version,"
 * shared by the create flow's fixture test path
 * (`customSourceCreateFlowService.testHandler`) and the scan worker's live
 * path (`customSourceScanWorker.runOne`). Both generation modes produce the
 * same `CustomSourceRunnerResult` shape, so callers don't need to branch —
 * only this module needs to know that `typescript_node` versions resolve a
 * stored source artifact and run through the sandboxed child-process runner,
 * while `declarative_pipeline_v1` versions run their stored pipeline
 * definition through the in-process step interpreter. Callers are still
 * responsible for the `evaluateCustomSourceRunnerBlockReason` fail-closed
 * check before calling this — it is not repeated here.
 */
export async function executeCustomSourceHandler(
  db: Queryable,
  config: ServerConfig,
  settings: CustomSourceRunnerSettings,
  args: {
    version: HandlerVersionRow;
    policyEnvelope: CustomSourcePolicyEnvelope;
    handlerInput: CustomSourceHandlerInput;
    /** Resolved once by the caller (never here) from `policyEnvelope.credential_ref` — see `customSourceCredentialService.ts`. Only meaningful for `declarative_pipeline_v1`: the `typescript_node` runner's child process never fetches anything itself, so its credential use (if any) is entirely the caller's pre-fetch concern. */
    credential?: CustomSourceFetchCredential | null;
    /** The outbound boundary the pipeline interpreter's live fetches go through. */
    guard?: OutboundGuard;
  },
): Promise<CustomSourceRunnerResult> {
  if (args.policyEnvelope.language === "declarative_pipeline_v1") {
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

  const entrypointPath = await resolveHandlerSourcePath(db, config, args.version);
  return new CustomSourceRunner(settings).run({
    policyEnvelope: args.policyEnvelope,
    handlerInput: args.handlerInput,
    handlerEntrypointPath: entrypointPath,
  });
}

async function resolveHandlerSourcePath(
  db: Queryable,
  config: ServerConfig,
  version: HandlerVersionRow,
): Promise<string> {
  if (!version.handler_artifact_id) throw new HttpError(422, "Handler version has no stored source artifact");
  const artifact = await db.query<{ storage_path: string }>(
    `SELECT storage_path FROM artifacts WHERE id = $1 AND space_id = $2`,
    [version.handler_artifact_id, version.space_id],
  );
  const storagePath = artifact.rows[0]?.storage_path;
  if (!storagePath) throw new HttpError(422, "Handler source artifact is missing its stored file");
  const absolute = resolveStoredArtifactPath(config.artifactStorageRoot, storagePath);
  if (!absolute) throw new HttpError(422, "Handler source artifact path is invalid");
  return absolute;
}
