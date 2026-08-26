import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type {
  RunInputEnvelope,
  RunOutputDeclaration,
  RunOutputManifestItem,
} from "@rainver/protocol";
import { validateStructuredOutput } from "./structuredOutputValidation.js";

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_FILES = 128;
const MAX_OUTPUT_DEPTH = 8;

export interface RunExchangeHandle {
  root: string;
  input_dir: string;
  output_dir: string;
  input_manifest_path: string;
  input_sha256: string;
}

export interface RunExchangeCollection {
  manifest: RunOutputManifestItem[];
  artifact_paths: Array<{
    path: string;
    title: string;
    mime_type: string;
    output_name: string;
    declared: boolean;
  }>;
  errors: string[];
  reported_status: "succeeded" | "rejected" | null;
}

export interface RunExchangePort {
  prepare(spaceId: string, runId: string, input: RunInputEnvelope): Promise<RunExchangeHandle>;
  collect(handle: RunExchangeHandle, declarations: RunOutputDeclaration[]): Promise<RunExchangeCollection>;
  cleanup(handle: RunExchangeHandle): Promise<void>;
}

export class RunExchangeManager implements RunExchangePort {
  private readonly exchangeRoot: string;

  constructor(sandboxRoot: string) {
    this.exchangeRoot = resolve(sandboxRoot, "exchange");
  }

  async prepare(
    spaceId: string,
    runId: string,
    input: RunInputEnvelope,
  ): Promise<RunExchangeHandle> {
    const root = this.contained(resolve(this.exchangeRoot, safeSegment(spaceId), safeSegment(runId)));
    await makeWritableForCleanup(root);
    await rm(root, { recursive: true, force: true });
    const inputDir = resolve(root, "input");
    const outputDir = resolve(root, "output");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(inputDir, { mode: 0o700 });
    await mkdir(outputDir, { mode: 0o700 });
    const body = `${JSON.stringify(input, null, 2)}\n`;
    const inputManifestPath = resolve(inputDir, "run_input.json");
    await writeFile(inputManifestPath, body, { encoding: "utf8", mode: 0o400 });
    await chmod(inputDir, 0o500);
    return {
      root,
      input_dir: inputDir,
      output_dir: outputDir,
      input_manifest_path: inputManifestPath,
      input_sha256: sha256(body),
    };
  }

  async collect(
    handle: RunExchangeHandle,
    declarations: RunOutputDeclaration[],
  ): Promise<RunExchangeCollection> {
    this.assertHandle(handle);
    const errors: string[] = [];
    const manifest: RunOutputManifestItem[] = [];
    const artifactPaths: RunExchangeCollection["artifact_paths"] = [];
    let reportedStatus: RunExchangeCollection["reported_status"] = null;
    const inputBody = await readFile(handle.input_manifest_path, "utf8");
    if (sha256(inputBody) !== handle.input_sha256) {
      errors.push("Run Exchange input manifest was modified during execution");
    }

    const declaredPaths = new Set<string>();
    for (const declaration of declarations) {
      const path = safeRelativePath(declaration.path);
      declaredPaths.add(path);
      const absolute = this.outputPath(handle, path);
      const inspected = await inspectRegularFile(absolute);
      if (!inspected.exists) {
        manifest.push({
          name: declaration.name,
          status: "missing",
          artifact_id: null,
          media_type: declaration.media_type ?? null,
          size_bytes: null,
          validation_errors: declaration.required ? ["required output is missing"] : [],
        });
        if (declaration.required) errors.push(`Required Run Exchange output '${declaration.name}' is missing`);
        continue;
      }
      if (!inspected.regular) {
        manifest.push(invalidItem(declaration, inspected.size, "output is not a regular contained file"));
        if (declaration.required) errors.push(`Required Run Exchange output '${declaration.name}' is invalid`);
        continue;
      }
      const maxBytes = declaration.max_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      if (inspected.size > maxBytes) {
        manifest.push({
          name: declaration.name,
          status: "oversized",
          artifact_id: null,
          media_type: declaration.media_type ?? null,
          size_bytes: inspected.size,
          validation_errors: [`output exceeds ${maxBytes} bytes`],
        });
        if (declaration.required) errors.push(`Required Run Exchange output '${declaration.name}' is oversized`);
        continue;
      }
      const validationErrors = await validateDeclaredFile(absolute, declaration);
      if (validationErrors.length > 0) {
        manifest.push(invalidItem(declaration, inspected.size, validationErrors[0]!));
        if (declaration.required) errors.push(`Required Run Exchange output '${declaration.name}' failed validation`);
        continue;
      }
      if (declaration.name === "conversation_capture") {
        const capture = JSON.parse(await readFile(absolute, "utf8")) as {
          status?: unknown;
        };
        if (capture.status === "succeeded" || capture.status === "rejected") {
          reportedStatus = capture.status;
        }
      }
      manifest.push({
        name: declaration.name,
        status: "valid",
        artifact_id: null,
        media_type: declaration.media_type ?? mimeType(path),
        size_bytes: inspected.size,
        validation_errors: [],
      });
      artifactPaths.push({
        path,
        title: declaration.name,
        mime_type: declaration.media_type ?? mimeType(path),
        output_name: declaration.name,
        declared: true,
      });
    }

    const files = await listOutputFiles(handle.output_dir);
    for (const path of files.slice(0, MAX_OUTPUT_FILES)) {
      if (declaredPaths.has(path)) continue;
      const absolute = this.outputPath(handle, path);
      const inspected = await inspectRegularFile(absolute);
      if (!inspected.regular || inspected.size > DEFAULT_MAX_OUTPUT_BYTES) continue;
      manifest.push({
        name: path,
        status: "undeclared",
        artifact_id: null,
        media_type: mimeType(path),
        size_bytes: inspected.size,
        validation_errors: [],
      });
      artifactPaths.push({
        path,
        title: path,
        mime_type: mimeType(path),
        output_name: path,
        declared: false,
      });
    }
    return {
      manifest,
      artifact_paths: artifactPaths,
      errors,
      reported_status: reportedStatus,
    };
  }

  async cleanup(handle: RunExchangeHandle): Promise<void> {
    this.assertHandle(handle);
    await makeWritableForCleanup(handle.root);
    await rm(handle.root, { recursive: true, force: true });
    await rmdir(dirname(handle.root)).catch(() => {});
  }

  private outputPath(handle: RunExchangeHandle, path: string): string {
    const absolute = resolve(handle.output_dir, safeRelativePath(path));
    if (!isInside(absolute, handle.output_dir)) throw new Error("Run Exchange output path escapes output root");
    return absolute;
  }

  private assertHandle(handle: RunExchangeHandle): void {
    this.contained(handle.root);
    if (!isInside(handle.input_dir, handle.root) || !isInside(handle.output_dir, handle.root)) {
      throw new Error("Run Exchange handle escapes its root");
    }
  }

  private contained(path: string): string {
    const absolute = resolve(path);
    if (!isInside(absolute, this.exchangeRoot)) throw new Error("Run Exchange path escapes sandbox root");
    return absolute;
  }
}

async function makeWritableForCleanup(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => {});
  await chmod(resolve(root, "input"), 0o700).catch(() => {});
}

async function listOutputFiles(
  root: string,
  current = root,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_OUTPUT_DEPTH) return [];
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.slice(0, MAX_OUTPUT_FILES)) {
    const absolute = resolve(current, entry.name);
    if (!isInside(absolute, root)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await listOutputFiles(root, absolute, depth + 1));
    else if (entry.isFile()) files.push(relative(root, absolute));
    if (files.length >= MAX_OUTPUT_FILES) break;
  }
  return files;
}

async function inspectRegularFile(path: string): Promise<{ exists: boolean; regular: boolean; size: number }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { exists: true, regular: false, size: info.size };
    const canonical = await realpath(path);
    return { exists: true, regular: canonical === resolve(path), size: info.size };
  } catch {
    return { exists: false, regular: false, size: 0 };
  }
}

async function validateDeclaredFile(
  path: string,
  declaration: RunOutputDeclaration,
): Promise<string[]> {
  if (!declaration.json_schema) return [];
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const schema = declaration.json_schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return ["JSON schema is invalid"];
    const error = validateStructuredOutput(value, {
      schema_id: declaration.name,
      schema: schema as Record<string, unknown>,
    });
    return error ? [error] : [];
  } catch {
    return ["output is not valid JSON"];
  }
}

function invalidItem(
  declaration: RunOutputDeclaration,
  size: number,
  message: string,
): RunOutputManifestItem {
  return {
    name: declaration.name,
    status: "invalid",
    artifact_id: null,
    media_type: declaration.media_type ?? null,
    size_bytes: size,
    validation_errors: [message],
  };
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) throw new Error("Run Exchange path must be relative and contained");
  return normalized;
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value) || value === "." || value === "..") {
    throw new Error("Run Exchange identifier is not path-safe");
  }
  return value;
}

function isInside(child: string, root: string): boolean {
  const absoluteChild = resolve(child);
  const absoluteRoot = resolve(root);
  return absoluteChild === absoluteRoot || absoluteChild.startsWith(`${absoluteRoot}${sep}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mimeType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}
