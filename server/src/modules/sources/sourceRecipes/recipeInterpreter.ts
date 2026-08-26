import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CustomSourcePipelineDefinition,
  CustomSourcePolicyLimits,
  SourcePolicyEnvelope,
  SourceRecipeDefinition,
  SourceRecipeNextPage,
  SourceRecipePaginateStep,
  SourceRecipeStep,
  SourceRecipeStepTrace,
} from "@agent-space/protocol";
import { redactSecretPatterns } from "../../runs/evidenceRedaction.js";
import {
  fetchAllowedOriginResponse,
  truncateToByteLimit,
  type CustomSourceFetchCredential,
} from "../customSources/customSourceEndpointFetch.js";
import {
  bodyOnly,
  buildListItems,
  buildSinglePageItem,
  extractTagText,
  resolveUrl,
  stripTags,
  type CustomSourcePipelineItem,
} from "../customSources/customSourceHtmlExtract.js";
import { parseFeed, type ParsedFeedItem } from "../feedParser.js";
import { sha256 } from "../sourceRepositoryMappers.js";
import { effectiveCustomSourceLimits, type CustomSourceRunnerSettings } from "../customSources/customSourceRunner.js";

/**
 * Level 2 Source recipe interpreter: executes a `source.recipe.v1` definition
 * with trusted, in-process platform code only — the recipe is data, never
 * code, so there is nothing to sandbox. Ported from the declarative pipeline
 * interpreter seed (`customSourcePipelineInterpreter.ts`, which remains for
 * advanced/history `declarative_pipeline_v1` handler versions and the explicit
 * bridge path), with three Level 2 additions: feed-parsing and dedupe
 * primitives, a per-step execution trace, and followed/skipped URL accounting
 * for dry-run preview.
 *
 * Every live network request goes through `fetchAllowedOriginResponse`
 * (origin allowlist + redirect revalidation). `mode: "dry_run"` stays
 * offline and side-effect free: only the primary-endpoint sentinel resolves
 * (to caller-provided pre-fetched or fixture content); every other
 * live-fetch-capable step is skipped with a trace entry and its target URLs
 * recorded in `skipped_urls`.
 */

const PRIMARY_ENDPOINT_SENTINEL = "$source.endpoint_url";

export type SourceRecipeRunMode = "dry_run" | "scan";

class RecipeStepError extends Error {}
class RecipeTimeoutError extends Error {}

interface HtmlVar {
  kind: "html";
  value: string;
  sourceUrl: string | null;
}
interface ItemsVar {
  kind: "items";
  value: CustomSourcePipelineItem[];
}
type RecipeVar = HtmlVar | ItemsVar;

interface RecipeContext {
  vars: Map<string, RecipeVar>;
  policyEnvelope: SourcePolicyEnvelope;
  limits: CustomSourcePolicyLimits;
  mode: SourceRecipeRunMode;
  endpointUrl: string | null;
  sourceName: string;
  primaryEndpointContent: string;
  filesRoot: string;
  filesWritten: number;
  warnings: string[];
  traces: SourceRecipeStepTrace[];
  followedUrls: string[];
  skippedUrls: string[];
  deadlineAt: number;
  /** Resolved once per run by the caller from `policyEnvelope.credential_ref`; injected into every live fetch, never logged. */
  credential: CustomSourceFetchCredential | null;
}

export interface SourceRecipeRunInput {
  policyEnvelope: SourcePolicyEnvelope;
  recipe: SourceRecipeDefinition;
  mode: SourceRecipeRunMode;
  endpointUrl: string | null;
  sourceName: string;
  /** Pre-fetched (or fixture) content for the primary-endpoint sentinel — the caller owns that one trusted fetch. */
  primaryEndpointContent: string;
  credential?: CustomSourceFetchCredential | null;
}

export interface SourceRecipeRunResult {
  status: "succeeded" | "failed";
  timed_out: boolean;
  error: string | null;
  items: CustomSourcePipelineItem[];
  /** `custom_source.handler_output.v1` JSON for the shared contract validator/materializer; null when failed or too large. */
  raw_output_json: string | null;
  output_too_large: boolean;
  warnings: string[];
  step_traces: SourceRecipeStepTrace[];
  followed_urls: string[];
  skipped_urls: string[];
  sandbox_files_root: string;
}

export async function runSourceRecipe(
  settings: CustomSourceRunnerSettings,
  input: SourceRecipeRunInput,
): Promise<SourceRecipeRunResult> {
  const sandboxRoot = join(tmpdir(), `source-recipe-${randomUUID()}`);
  const filesRoot = join(sandboxRoot, "files");
  await mkdir(filesRoot, { recursive: true });

  const limits = effectiveCustomSourceLimits(settings, input.policyEnvelope.limits);
  const ctx: RecipeContext = {
    vars: new Map(),
    policyEnvelope: input.policyEnvelope,
    limits,
    mode: input.mode,
    endpointUrl: input.endpointUrl,
    sourceName: input.sourceName,
    primaryEndpointContent: input.primaryEndpointContent,
    filesRoot,
    filesWritten: 0,
    warnings: [],
    traces: [],
    followedUrls: [],
    skippedUrls: [],
    deadlineAt: Date.now() + limits.timeout_ms,
    credential: input.credential ?? null,
  };

  try {
    await executeSteps(ctx, input.recipe.steps, "steps");
    const outputVar = ctx.vars.get(input.recipe.output.items_var);
    if (!outputVar || outputVar.kind !== "items") {
      throw new RecipeStepError(
        `recipe output.items_var "${input.recipe.output.items_var}" was never bound to an items result`,
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
      status: "succeeded",
      timed_out: false,
      error: null,
      items,
      raw_output_json: outputTooLarge ? null : rawOutputJson,
      output_too_large: outputTooLarge,
      warnings: ctx.warnings.map((warning) => redactSecretPatterns(warning)),
      step_traces: ctx.traces,
      followed_urls: ctx.followedUrls,
      skipped_urls: ctx.skippedUrls,
      sandbox_files_root: filesRoot,
    };
  } catch (error) {
    const timedOut = error instanceof RecipeTimeoutError;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      timed_out: timedOut,
      error: redactSecretPatterns(message),
      items: [],
      raw_output_json: null,
      output_too_large: false,
      warnings: ctx.warnings.map((warning) => redactSecretPatterns(warning)),
      step_traces: ctx.traces,
      followed_urls: ctx.followedUrls,
      skipped_urls: ctx.skippedUrls,
      sandbox_files_root: filesRoot,
    };
  }
}

/**
 * Wraps existing `declarative_pipeline_v1` pipeline definitions as Level 2
 * recipes — the pipeline step catalog is a strict subset of the recipe step
 * catalog with identical field shapes, so pipeline fixtures can run through
 * this interpreter unchanged.
 */
export function recipeFromPipelineDefinition(pipeline: CustomSourcePipelineDefinition): SourceRecipeDefinition {
  return {
    recipe_version: "source.recipe.v1",
    steps: pipeline.steps as unknown as SourceRecipeStep[],
    output: { items_var: pipeline.output.items_var },
  };
}

async function executeSteps(ctx: RecipeContext, steps: SourceRecipeStep[], pathPrefix: string): Promise<void> {
  for (const [index, step] of steps.entries()) {
    checkDeadline(ctx);
    const stepPath = `${pathPrefix}[${index}]`;
    const startedAt = Date.now();
    const trace: SourceRecipeStepTrace = {
      step_path: stepPath,
      primitive: step.type,
      status: "succeeded",
      duration_ms: 0,
    };
    ctx.traces.push(trace);
    try {
      await executeStep(ctx, step, trace, stepPath);
    } catch (error) {
      trace.status = "failed";
      trace.detail = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      trace.duration_ms = Math.max(0, Date.now() - startedAt);
    }
  }
}

async function executeStep(
  ctx: RecipeContext,
  step: SourceRecipeStep,
  trace: SourceRecipeStepTrace,
  stepPath: string,
): Promise<void> {
  switch (step.type) {
    case "fetch_page":
      return execFetchPage(ctx, step, trace);
    case "parse_rss":
      return execParseFeed(ctx, step, trace, "rss");
    case "parse_atom":
      return execParseFeed(ctx, step, trace, "atom");
    case "extract_list":
      return execExtractList(ctx, step, trace);
    case "extract_single":
      return execExtractSingle(ctx, step, trace);
    case "follow_link":
      return execFollowLink(ctx, step, trace);
    case "download_asset":
      return execDownloadAsset(ctx, step, trace);
    case "paginate":
      return execPaginate(ctx, step, trace, stepPath);
    case "dedupe":
      return execDedupe(ctx, step, trace);
  }
}

function checkDeadline(ctx: RecipeContext): void {
  if (Date.now() > ctx.deadlineAt) throw new RecipeTimeoutError("recipe exceeded its timeout budget");
}

function remainingMs(ctx: RecipeContext): number {
  return Math.max(1, ctx.deadlineAt - Date.now());
}

function requireVar<K extends RecipeVar["kind"]>(
  ctx: RecipeContext,
  name: string,
  kind: K,
): Extract<RecipeVar, { kind: K }> {
  const found = ctx.vars.get(name);
  if (!found) throw new RecipeStepError(`recipe variable "${name}" is not bound`);
  if (found.kind !== kind) {
    throw new RecipeStepError(`recipe variable "${name}" is a ${found.kind} value, expected ${kind}`);
  }
  return found as Extract<RecipeVar, { kind: K }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function execFetchPage(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "fetch_page" }>,
  trace: SourceRecipeStepTrace,
): Promise<void> {
  if (step.url === PRIMARY_ENDPOINT_SENTINEL) {
    ctx.vars.set(step.bind, { kind: "html", value: ctx.primaryEndpointContent, sourceUrl: ctx.endpointUrl });
    trace.fetched_url = ctx.endpointUrl;
    trace.detail = "primary endpoint content";
    return;
  }
  if (ctx.mode === "dry_run") {
    trace.status = "skipped";
    trace.detail = `live fetch of ${step.url} skipped in dry-run`;
    ctx.warnings.push(`fetch_page(${step.bind}): live fetch of ${step.url} skipped in dry-run`);
    ctx.skippedUrls.push(step.url);
    ctx.vars.set(step.bind, { kind: "html", value: "", sourceUrl: step.url });
    return;
  }
  checkDeadline(ctx);
  const response = await fetchAllowedOriginResponse(step.url, ctx.policyEnvelope.allowed_network_origins, {
    signal: AbortSignal.timeout(remainingMs(ctx)),
    credential: ctx.credential,
  });
  if (!response.ok) throw new RecipeStepError(`fetch_page(${step.bind}): HTTP ${response.status} from ${step.url}`);
  const text = truncateToByteLimit(await response.text(), ctx.limits.max_download_bytes);
  ctx.followedUrls.push(step.url);
  trace.fetched_url = step.url;
  ctx.vars.set(step.bind, { kind: "html", value: text, sourceUrl: step.url });
}

function execParseFeed(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "parse_rss" | "parse_atom" }>,
  trace: SourceRecipeStepTrace,
  feedType: "rss" | "atom",
): void {
  const inputVar = requireVar(ctx, step.input, "html");
  const maxItems = Math.min(step.max_items ?? ctx.limits.max_items, ctx.limits.max_items);
  let parsed: ParsedFeedItem[];
  try {
    parsed = parseFeed(inputVar.value, feedType);
  } catch (error) {
    throw new RecipeStepError(`parse_${feedType}(${step.bind}): ${errorMessage(error)}`);
  }
  const baseUrl = inputVar.sourceUrl ?? ctx.endpointUrl;
  const items = parsed.slice(0, maxItems).map((feedItem, index) => feedItemToRecipeItem(feedItem, baseUrl, index));
  trace.item_count = items.length;
  ctx.vars.set(step.bind, { kind: "items", value: items });
}

function feedItemToRecipeItem(
  feedItem: ParsedFeedItem,
  baseUrl: string | null,
  index: number,
): CustomSourcePipelineItem {
  const sourceUri = resolveUrl(feedItem.url, baseUrl) ?? baseUrl ?? `item-${index}`;
  return {
    external_id: feedItem.externalId ?? feedItem.url ?? sha256(`${feedItem.title}#${index}`),
    title: feedItem.title.slice(0, 512),
    source_uri: sourceUri,
    published_at: feedItem.occurredAt,
    author: feedItem.author,
    excerpt: feedItem.excerpt,
    metadata: feedItem.metadata,
    snapshots: [],
    evidence: [],
  };
}

function execExtractList(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "extract_list" }>,
  trace: SourceRecipeStepTrace,
): void {
  const inputVar = requireVar(ctx, step.input, "html");
  const maxItems = Math.min(step.max_items ?? ctx.limits.max_items, ctx.limits.max_items);
  const items = buildListItems({
    html: inputVar.value,
    cssClass: step.selector.css_class,
    baseUrl: inputVar.sourceUrl ?? ctx.endpointUrl,
    maxItems,
  });
  trace.item_count = items.length;
  ctx.vars.set(step.bind, { kind: "items", value: items });
}

function execExtractSingle(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "extract_single" }>,
  trace: SourceRecipeStepTrace,
): void {
  const inputVar = requireVar(ctx, step.input, "html");
  const endpointUrl = inputVar.sourceUrl ?? ctx.endpointUrl;
  const item = buildSinglePageItem({
    html: inputVar.value,
    endpointUrl,
    fallbackTitle: ctx.sourceName,
  });
  trace.item_count = 1;
  ctx.vars.set(step.bind, { kind: "items", value: [item] });
}

async function execFollowLink(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "follow_link" }>,
  trace: SourceRecipeStepTrace,
): Promise<void> {
  const itemsVar = requireVar(ctx, step.items_var, "items");
  const followCount = Math.min(step.max_follow, itemsVar.value.length);
  if (ctx.mode === "dry_run") {
    trace.status = "skipped";
    trace.detail = `live fetch of ${followCount} item link(s) skipped in dry-run`;
    ctx.warnings.push(`follow_link(${step.items_var}): live fetch skipped in dry-run`);
    for (let i = 0; i < followCount; i++) ctx.skippedUrls.push(itemsVar.value[i]!.source_uri);
    return;
  }
  let followed = 0;
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
    ctx.followedUrls.push(item.source_uri);
    followed += 1;
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
  trace.item_count = followed;
}

async function execDownloadAsset(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "download_asset" }>,
  trace: SourceRecipeStepTrace,
): Promise<void> {
  const itemsVar = requireVar(ctx, step.items_var, "items");
  if (ctx.mode === "dry_run") {
    trace.status = "skipped";
    trace.detail = `download of ${itemsVar.value.length} asset(s) skipped in dry-run`;
    ctx.warnings.push(`download_asset(${step.items_var}): live fetch skipped in dry-run`);
    for (const item of itemsVar.value) ctx.skippedUrls.push(item.source_uri);
    return;
  }
  let downloaded = 0;
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
    ctx.followedUrls.push(item.source_uri);
    const filePath = await writeSnapshotBuffer(ctx, buf, extensionForMime(mimeType));
    item.snapshots.push({ snapshot_type: "download", file_path: filePath, mime_type: mimeType });
    ctx.filesWritten += 1;
    downloaded += 1;
  }
  trace.item_count = downloaded;
}

async function execPaginate(
  ctx: RecipeContext,
  step: SourceRecipePaginateStep,
  trace: SourceRecipeStepTrace,
  stepPath: string,
): Promise<void> {
  const pageVar = requireVar(ctx, step.input, "html");
  let currentHtml = pageVar.value;
  let currentUrl = pageVar.sourceUrl;
  const merged: CustomSourcePipelineItem[] = [];
  let pagesProcessed = 0;

  for (let pageIndex = 1; pageIndex <= step.max_pages; pageIndex++) {
    ctx.vars.set(step.input, { kind: "html", value: currentHtml, sourceUrl: currentUrl });
    await executeSteps(ctx, step.steps, `${stepPath}.steps`);
    pagesProcessed = pageIndex;
    const produced = ctx.vars.get(step.page_items_var);
    if (produced && produced.kind === "items") {
      for (const item of produced.value) {
        if (merged.length >= ctx.limits.max_items) break;
        merged.push(item);
      }
    }
    if (merged.length >= ctx.limits.max_items || pageIndex === step.max_pages) break;

    const nextUrl = resolveNextPageUrl(step.next_page, currentUrl, currentHtml, pageIndex);
    if (!nextUrl) break;
    if (ctx.mode === "dry_run") {
      ctx.warnings.push(`paginate: fetch of page ${pageIndex + 1} (${nextUrl}) skipped in dry-run`);
      ctx.skippedUrls.push(nextUrl);
      break;
    }
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
    ctx.followedUrls.push(nextUrl);
    currentHtml = truncateToByteLimit(await response.text(), ctx.limits.max_download_bytes);
    currentUrl = nextUrl;
  }

  trace.item_count = merged.length;
  trace.detail = `processed ${pagesProcessed} page(s)`;
  ctx.vars.set(step.bind, { kind: "items", value: merged });
}

function execDedupe(
  ctx: RecipeContext,
  step: Extract<SourceRecipeStep, { type: "dedupe" }>,
  trace: SourceRecipeStepTrace,
): void {
  const inputVar = requireVar(ctx, step.input, "items");
  const by = step.by ?? "external_id";
  const seen = new Set<string>();
  const deduped: CustomSourcePipelineItem[] = [];
  for (const item of inputVar.value) {
    const key = by === "source_uri" ? item.source_uri : item.external_id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  if (deduped.length < inputVar.value.length) {
    trace.detail = `dropped ${inputVar.value.length - deduped.length} duplicate item(s) by ${by}`;
  }
  trace.item_count = deduped.length;
  ctx.vars.set(step.bind, { kind: "items", value: deduped });
}

function resolveNextPageUrl(
  nextPage: SourceRecipeNextPage,
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

async function writeSnapshotText(ctx: RecipeContext, text: string, extension: string): Promise<string> {
  return writeSnapshotBuffer(ctx, Buffer.from(text, "utf8"), extension);
}

async function writeSnapshotBuffer(ctx: RecipeContext, buf: Buffer, extension: string): Promise<string> {
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
