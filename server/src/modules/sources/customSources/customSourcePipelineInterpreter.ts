import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CustomSourceHandlerInput,
  CustomSourcePipelineDefinition,
  CustomSourcePipelineNextPage,
  CustomSourcePipelinePaginateStep,
  CustomSourcePipelineStep,
  CustomSourcePolicyEnvelope,
  CustomSourcePolicyLimits,
} from "@agent-space/protocol";
import { redactSecretPatterns } from "../../runs/evidenceRedaction.js";
import {
  fetchAllowedOriginResponse,
  truncateToByteLimit,
  type CustomSourceFetchCredential,
} from "./customSourceEndpointFetch.js";
import {
  buildListItems,
  buildSinglePageItem,
  bodyOnly,
  extractTagText,
  resolveUrl,
  stripTags,
  type CustomSourcePipelineItem,
} from "./customSourceHtmlExtract.js";
import {
  effectiveCustomSourceLimits,
  type CustomSourceRunnerResult,
  type CustomSourceRunnerSettings,
} from "./customSourceRunner.js";

/**
 * Interpreter for `language: "declarative_pipeline_v1"` handler versions.
 * Unlike `CustomSourceRunner` (which spawns a separate OS process to run
 * *generated code* it cannot fully trust), this executes a fixed, small step
 * catalog implemented once by this trusted server module — there is no
 * generated/untrusted code to isolate from the host. Every step that
 * performs a live network request goes through `fetchAllowedOriginResponse`,
 * the same origin-allowlist + redirect-revalidation guard the code-template
 * mode's pre-fetch uses. See
 * `.agent/architecture/SOURCE_CUSTOM_SOURCE_HANDLERS.md`.
 *
 * `mode: "test"` runs only ever read the already-provided/fixture-overridable
 * primary endpoint HTML (`handlerInput.source.config.fetched_html`) for a
 * `fetch_page` step targeting the primary endpoint sentinel. Every other
 * live-fetch-capable step (`follow_link`, `download_asset`, `paginate`, or a
 * `fetch_page` with a literal URL) is a deliberate no-op in test mode — a
 * fixture test must stay offline and side-effect free, the same expectation
 * the code-template mode's fully network-blocked handler process already
 * satisfies.
 */

const PRIMARY_ENDPOINT_SENTINEL = "$source.endpoint_url";

/** `source_handler_versions.entrypoint` is `NOT NULL`; pipeline-mode versions have no source file to point at, so this constant fills that column. */
export const CUSTOM_SOURCE_PIPELINE_HANDLER_ENTRYPOINT = "pipeline";

class PipelineStepError extends Error {}
class PipelineTimeoutError extends Error {}

interface HtmlVar {
  kind: "html";
  value: string;
  sourceUrl: string | null;
}
interface ItemsVar {
  kind: "items";
  value: CustomSourcePipelineItem[];
}
type PipelineVar = HtmlVar | ItemsVar;

interface PipelineContext {
  vars: Map<string, PipelineVar>;
  policyEnvelope: CustomSourcePolicyEnvelope;
  handlerInput: CustomSourceHandlerInput;
  limits: CustomSourcePolicyLimits;
  isTestMode: boolean;
  filesRoot: string;
  filesWritten: number;
  warnings: string[];
  deadlineAt: number;
  /** Resolved once per run by the caller (never by this module) from `policyEnvelope.credential_ref` — see `customSourceCredentialService.ts`. Injected into every live fetch this interpreter makes; never exposed to `handlerInput` or logs. */
  credential: CustomSourceFetchCredential | null;
}

export interface CustomSourcePipelineRunInput {
  policyEnvelope: CustomSourcePolicyEnvelope;
  handlerInput: CustomSourceHandlerInput;
  pipeline: CustomSourcePipelineDefinition;
  credential?: CustomSourceFetchCredential | null;
}

export async function runCustomSourcePipeline(
  settings: CustomSourceRunnerSettings,
  input: CustomSourcePipelineRunInput,
): Promise<CustomSourceRunnerResult> {
  const sandboxRoot = join(tmpdir(), `custom-source-pipeline-${randomUUID()}`);
  const filesRoot = join(sandboxRoot, "files");
  await mkdir(filesRoot, { recursive: true });

  const limits = effectiveCustomSourceLimits(settings, input.policyEnvelope.limits);
  const ctx: PipelineContext = {
    vars: new Map(),
    policyEnvelope: input.policyEnvelope,
    handlerInput: input.handlerInput,
    limits,
    isTestMode: input.handlerInput.run.mode === "test",
    filesRoot,
    filesWritten: 0,
    warnings: [],
    deadlineAt: Date.now() + limits.timeout_ms,
    credential: input.credential ?? null,
  };

  try {
    await executeSteps(ctx, input.pipeline.steps);
    const outputVar = ctx.vars.get(input.pipeline.output.items_var);
    if (!outputVar || outputVar.kind !== "items") {
      throw new PipelineStepError(
        `pipeline output.items_var "${input.pipeline.output.items_var}" was never bound to an items result`,
      );
    }
    const items = outputVar.value.slice(0, limits.max_items).map((item) => ({
      ...item,
      metadata: item.metadata ?? {},
    }));
    const rawOutputJson = JSON.stringify({
      contract_version: "custom_source.handler_output.v1",
      cursor: null,
      items,
      diagnostics: { warnings: ctx.warnings },
    });
    const outputTooLarge = Buffer.byteLength(rawOutputJson, "utf8") > limits.max_output_bytes;
    return {
      status: "completed",
      exit_code: 0,
      timed_out: false,
      logs: redactSecretPatterns(ctx.warnings.join("\n")),
      logs_truncated: false,
      raw_output_json: outputTooLarge ? null : rawOutputJson,
      output_too_large: outputTooLarge,
      sandbox_files_root: filesRoot,
    };
  } catch (error) {
    const timedOut = error instanceof PipelineTimeoutError;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "completed",
      exit_code: timedOut ? null : 1,
      timed_out: timedOut,
      logs: redactSecretPatterns([...ctx.warnings, message].join("\n")),
      logs_truncated: false,
      raw_output_json: null,
      output_too_large: false,
      sandbox_files_root: filesRoot,
    };
  }
}

async function executeSteps(ctx: PipelineContext, steps: CustomSourcePipelineStep[]): Promise<void> {
  for (const step of steps) {
    checkDeadline(ctx);
    await executeStep(ctx, step);
  }
}

async function executeStep(ctx: PipelineContext, step: CustomSourcePipelineStep): Promise<void> {
  switch (step.type) {
    case "fetch_page":
      return execFetchPage(ctx, step);
    case "extract_list":
      return execExtractList(ctx, step);
    case "extract_single":
      return execExtractSingle(ctx, step);
    case "follow_link":
      return execFollowLink(ctx, step);
    case "download_asset":
      return execDownloadAsset(ctx, step);
    case "paginate":
      return execPaginate(ctx, step);
  }
}

function checkDeadline(ctx: PipelineContext): void {
  if (Date.now() > ctx.deadlineAt) throw new PipelineTimeoutError("pipeline exceeded its timeout budget");
}

function remainingMs(ctx: PipelineContext): number {
  return Math.max(1, ctx.deadlineAt - Date.now());
}

function primaryEndpointUrl(ctx: PipelineContext): string | null {
  return ctx.handlerInput.source.endpoint_url ?? null;
}

function requireVar<K extends PipelineVar["kind"]>(
  ctx: PipelineContext,
  name: string,
  kind: K,
): Extract<PipelineVar, { kind: K }> {
  const found = ctx.vars.get(name);
  if (!found) throw new PipelineStepError(`pipeline variable "${name}" is not bound`);
  if (found.kind !== kind) {
    throw new PipelineStepError(`pipeline variable "${name}" is a ${found.kind} value, expected ${kind}`);
  }
  return found as Extract<PipelineVar, { kind: K }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function execFetchPage(
  ctx: PipelineContext,
  step: Extract<CustomSourcePipelineStep, { type: "fetch_page" }>,
): Promise<void> {
  if (step.url === PRIMARY_ENDPOINT_SENTINEL) {
    const config = ctx.handlerInput.source.config as { fetched_html?: unknown } | null;
    const html = typeof config?.fetched_html === "string" ? config.fetched_html : "";
    ctx.vars.set(step.bind, { kind: "html", value: html, sourceUrl: primaryEndpointUrl(ctx) });
    return;
  }
  if (ctx.isTestMode) {
    ctx.warnings.push(`fetch_page(${step.bind}): live fetch of ${step.url} skipped in test mode`);
    ctx.vars.set(step.bind, { kind: "html", value: "", sourceUrl: step.url });
    return;
  }
  checkDeadline(ctx);
  const response = await fetchAllowedOriginResponse(step.url, ctx.policyEnvelope.allowed_network_origins, {
    signal: AbortSignal.timeout(remainingMs(ctx)),
    credential: ctx.credential,
  });
  if (!response.ok) throw new PipelineStepError(`fetch_page(${step.bind}): HTTP ${response.status} from ${step.url}`);
  const text = truncateToByteLimit(await response.text(), ctx.limits.max_download_bytes);
  ctx.vars.set(step.bind, { kind: "html", value: text, sourceUrl: step.url });
}

function execExtractList(
  ctx: PipelineContext,
  step: Extract<CustomSourcePipelineStep, { type: "extract_list" }>,
): void {
  const inputVar = requireVar(ctx, step.input, "html");
  const maxItems = Math.min(step.max_items ?? ctx.limits.max_items, ctx.limits.max_items);
  const items = buildListItems({
    html: inputVar.value,
    cssClass: step.selector.css_class,
    baseUrl: inputVar.sourceUrl ?? primaryEndpointUrl(ctx),
    maxItems,
  });
  ctx.vars.set(step.bind, { kind: "items", value: items });
}

function execExtractSingle(
  ctx: PipelineContext,
  step: Extract<CustomSourcePipelineStep, { type: "extract_single" }>,
): void {
  const inputVar = requireVar(ctx, step.input, "html");
  const endpointUrl = inputVar.sourceUrl ?? primaryEndpointUrl(ctx);
  const item = buildSinglePageItem({
    html: inputVar.value,
    endpointUrl,
    fallbackTitle: ctx.handlerInput.source.name,
  });
  ctx.vars.set(step.bind, { kind: "items", value: [item] });
}

async function execFollowLink(
  ctx: PipelineContext,
  step: Extract<CustomSourcePipelineStep, { type: "follow_link" }>,
): Promise<void> {
  const itemsVar = requireVar(ctx, step.items_var, "items");
  if (ctx.isTestMode) {
    ctx.warnings.push(`follow_link(${step.items_var}): live fetch skipped in test mode`);
    return;
  }
  const followCount = Math.min(step.max_follow, itemsVar.value.length);
  for (let i = 0; i < followCount; i++) {
    checkDeadline(ctx);
    const item = itemsVar.value[i]!;
    let text: string;
    try {
      const response = await fetchAllowedOriginResponse(item.source_uri, ctx.policyEnvelope.allowed_network_origins, {
        signal: AbortSignal.timeout(remainingMs(ctx)),
        credential: ctx.credential,
      });
      if (!response.ok) {
        ctx.warnings.push(`follow_link: ${item.source_uri} returned HTTP ${response.status}`);
        continue;
      }
      text = truncateToByteLimit(await response.text(), ctx.limits.max_download_bytes);
    } catch (error) {
      ctx.warnings.push(`follow_link: ${item.source_uri} failed: ${errorMessage(error)}`);
      continue;
    }
    const detailTitle = extractTagText(text, "title");
    if (detailTitle) item.title = detailTitle.slice(0, 512);
    const detailExcerpt = stripTags(bodyOnly(text)).slice(0, 4000);
    if (detailExcerpt) item.excerpt = detailExcerpt;
    if (ctx.filesWritten < ctx.limits.max_files) {
      const filePath = await writeSnapshotText(ctx, text, "html");
      item.snapshots.push({ snapshot_type: "raw_html", file_path: filePath, mime_type: "text/html" });
      ctx.filesWritten += 1;
    } else {
      ctx.warnings.push(`follow_link: ${item.source_uri} snapshot skipped, max_files reached`);
    }
  }
}

async function execDownloadAsset(
  ctx: PipelineContext,
  step: Extract<CustomSourcePipelineStep, { type: "download_asset" }>,
): Promise<void> {
  const itemsVar = requireVar(ctx, step.items_var, "items");
  if (ctx.isTestMode) {
    ctx.warnings.push(`download_asset(${step.items_var}): live fetch skipped in test mode`);
    return;
  }
  for (const item of itemsVar.value) {
    if (ctx.filesWritten >= ctx.limits.max_files) {
      ctx.warnings.push("download_asset: max_files reached, remaining items skipped");
      break;
    }
    checkDeadline(ctx);
    let response: Response;
    try {
      response = await fetchAllowedOriginResponse(item.source_uri, ctx.policyEnvelope.allowed_network_origins, {
        signal: AbortSignal.timeout(remainingMs(ctx)),
        credential: ctx.credential,
      });
    } catch (error) {
      ctx.warnings.push(`download_asset: ${item.source_uri} failed: ${errorMessage(error)}`);
      continue;
    }
    if (!response.ok) {
      ctx.warnings.push(`download_asset: ${item.source_uri} returned HTTP ${response.status}`);
      continue;
    }
    const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    if (step.mime_allowlist && step.mime_allowlist.length > 0 && !step.mime_allowlist.includes(mimeType)) {
      ctx.warnings.push(`download_asset: ${item.source_uri} mime type ${mimeType} not in mime_allowlist`);
      continue;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > ctx.limits.max_download_bytes) {
      ctx.warnings.push(`download_asset: ${item.source_uri} exceeded max_download_bytes, skipped`);
      continue;
    }
    const filePath = await writeSnapshotBuffer(ctx, buf, extensionForMime(mimeType));
    item.snapshots.push({ snapshot_type: "download", file_path: filePath, mime_type: mimeType });
    ctx.filesWritten += 1;
  }
}

async function execPaginate(
  ctx: PipelineContext,
  step: CustomSourcePipelinePaginateStep,
): Promise<void> {
  const pageVar = requireVar(ctx, step.input, "html");
  let currentHtml = pageVar.value;
  let currentUrl = pageVar.sourceUrl;
  const merged: CustomSourcePipelineItem[] = [];

  for (let pageIndex = 1; pageIndex <= step.max_pages; pageIndex++) {
    ctx.vars.set(step.input, { kind: "html", value: currentHtml, sourceUrl: currentUrl });
    await executeSteps(ctx, step.steps);
    const produced = ctx.vars.get(step.page_items_var);
    if (produced && produced.kind === "items") {
      for (const item of produced.value) {
        if (merged.length >= ctx.limits.max_items) break;
        merged.push(item);
      }
    }
    if (merged.length >= ctx.limits.max_items || pageIndex === step.max_pages || ctx.isTestMode) break;

    const nextUrl = resolveNextPageUrl(step.next_page, currentUrl, currentHtml, pageIndex);
    if (!nextUrl) break;
    checkDeadline(ctx);
    let response: Response;
    try {
      response = await fetchAllowedOriginResponse(nextUrl, ctx.policyEnvelope.allowed_network_origins, {
        signal: AbortSignal.timeout(remainingMs(ctx)),
        credential: ctx.credential,
      });
    } catch (error) {
      ctx.warnings.push(`paginate: failed to fetch page ${pageIndex + 1}: ${errorMessage(error)}`);
      break;
    }
    if (!response.ok) {
      ctx.warnings.push(`paginate: page ${pageIndex + 1} returned HTTP ${response.status}`);
      break;
    }
    currentHtml = truncateToByteLimit(await response.text(), ctx.limits.max_download_bytes);
    currentUrl = nextUrl;
  }

  ctx.vars.set(step.bind, { kind: "items", value: merged });
}

function resolveNextPageUrl(
  nextPage: CustomSourcePipelineNextPage,
  currentUrl: string | null,
  currentHtml: string,
  pageIndex: number,
): string | null {
  if (nextPage.mode === "query_param") {
    if (!currentUrl) return null;
    try {
      const url = new URL(currentUrl);
      url.searchParams.set(nextPage.param, String(nextPage.start_page + pageIndex - 1));
      return url.toString();
    } catch {
      return null;
    }
  }
  const match =
    currentHtml.match(/<(?:a|link)[^>]*rel=["']next["'][^>]*href=["']([^"']+)["']/i) ??
    currentHtml.match(/<(?:a|link)[^>]*href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  if (!match) return null;
  return resolveUrl(match[1] ?? null, currentUrl);
}

async function writeSnapshotText(ctx: PipelineContext, text: string, extension: string): Promise<string> {
  return writeSnapshotBuffer(ctx, Buffer.from(text, "utf8"), extension);
}

async function writeSnapshotBuffer(ctx: PipelineContext, buf: Buffer, extension: string): Promise<string> {
  const fileName = `${createHash("sha256").update(buf).digest("hex")}.${extension}`;
  await writeFile(join(ctx.filesRoot, fileName), buf);
  return fileName;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "text/html": "html",
  "text/plain": "txt",
  "application/json": "json",
};

function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] ?? "bin";
}
