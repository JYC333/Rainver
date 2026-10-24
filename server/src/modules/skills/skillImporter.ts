import { createHash } from "node:crypto";
import { HttpError } from "../routeUtils/common.js";
import { parseSkillMarkdown } from "./skillParser.js";
import { analyzeSkillRisk } from "./skillRisk.js";
import { fetchSkillMetadata, fetchSkillSource } from "./skillSourceFetch.js";
import { assertSkillPackagePaths, isPlatformMetadataPath } from "./skillPackagePaths.js";
import type {
  NormalizedSkillResource,
  SkillImportPreview,
  SkillPackageFilePreview,
  SkillSourceType,
} from "./types.js";

export interface SkillFetcher {
  (url: string): Promise<{ body: string; bytes?: Uint8Array; finalUrl?: string | null; contentType?: string | null }>;
}

interface SkillCommitResolver {
  (repo: string, ref: string): Promise<string | null>;
}

interface SkillPackageListSource {
  repo: string;
  ref: string;
  commitSha: string | null;
  packageRoot: string;
  skillPath: string;
}

export interface SkillPackageTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number | null;
  sha?: string | null;
  mode?: string | null;
  contentType?: string | null;
  executable?: boolean | null;
}

export interface SkillPackageLister {
  (source: SkillPackageListSource): Promise<SkillPackageTreeEntry[]>;
}

export interface SkillImportOptions {
  fetcher?: SkillFetcher;
  commitResolver?: SkillCommitResolver | null;
  packageLister?: SkillPackageLister | null;
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_PACKAGE_FILES = 200;
const MAX_PACKAGE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_TEXT_FILE_BYTES = 256 * 1024;

// Only GitHub raw content is fetched. `normalizeSkillSourceUrl` always resolves
// file downloads to raw.githubusercontent.com, so any redirect target outside
// that host is treated as unsupported/private-network source material.
const ALLOWED_FETCH_HOSTS = new Set(["raw.githubusercontent.com"]);
const TEXT_RESOURCE_RE = /text|markdown|plain|json|yaml|yml|xml|csv|octet-stream/i;
const TEXT_RESOURCE_PATH_RE =
  /\.(md|markdown|txt|json|jsonl|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|fish|rb|pl|ps1|sql|svg|lock)$/i;
const EXECUTABLE_PATH_RE = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|tsx|rb|pl|ps1|php|go|rs|java|kt|swift)$/i;

function assertAllowedFetchHost(candidate: string): void {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(422, "Skill source URL is invalid");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_FETCH_HOSTS.has(parsed.hostname)) {
    throw new HttpError(422, "unsupported_skill_source");
  }
}

const defaultSkillFetcher: SkillFetcher = async (url) => {
  assertAllowedFetchHost(url);
  const response = await fetchSkillSource(url, MAX_SKILL_BYTES, "Skill source is too large");
  if (!response.ok) {
    throw new HttpError(response.status, `Skill source fetch failed with HTTP ${response.status}`);
  }
  // Every redirect was authorized before fetching; also retain the source check.
  if (response.url) assertAllowedFetchHost(response.url);
  const contentType = response.headers.get("content-type") ?? "";
  return { body: new TextDecoder().decode(response.bytes), bytes: response.bytes, finalUrl: response.url, contentType };
};

const defaultGitHubCommitResolver: SkillCommitResolver = async (repo, ref) => {
  if (commitSha(ref)) return ref;
  const response = await fetchSkillMetadata(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  if (!response.ok) return null;
  const parsed = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const sha = (parsed as { sha?: unknown }).sha;
  return typeof sha === "string" && commitSha(sha) ? sha : null;
};

const defaultGitHubPackageLister: SkillPackageLister = async (source) => {
  const treeish =
    source.commitSha ? await resolveGitHubTreeSha(source.repo, source.commitSha) : source.ref;
  const response = await fetchSkillMetadata(
    `https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`,
  );
  if (!response.ok) {
    throw new HttpError(response.status, `Skill package tree fetch failed with HTTP ${response.status}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(502, "Skill package tree response is invalid");
  }
  if ((parsed as { truncated?: unknown }).truncated === true) {
    throw new HttpError(422, "Skill package tree is too large to import safely");
  }
  const tree = (parsed as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) throw new HttpError(502, "Skill package tree response is invalid");
  return tree
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item): SkillPackageTreeEntry => ({
      path: typeof item.path === "string" ? item.path : "",
      type: item.type === "tree" ? "tree" : "blob",
      size: typeof item.size === "number" ? item.size : null,
      sha: typeof item.sha === "string" ? item.sha : null,
      mode: typeof item.mode === "string" ? item.mode : null,
      executable: typeof item.mode === "string" ? item.mode.endsWith("755") : null,
    }))
    .filter((entry) => entry.path && pathWithinRoot(entry.path, source.packageRoot));
};

async function resolveGitHubTreeSha(repo: string, commitShaValue: string): Promise<string> {
  const response = await fetchSkillMetadata(
    `https://api.github.com/repos/${repo}/git/commits/${encodeURIComponent(commitShaValue)}`,
  );
  if (!response.ok) return commitShaValue;
  const parsed = JSON.parse(new TextDecoder().decode(response.bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return commitShaValue;
  const tree = (parsed as { tree?: unknown }).tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return commitShaValue;
  const sha = (tree as { sha?: unknown }).sha;
  return typeof sha === "string" && commitSha(sha) ? sha : commitShaValue;
}

export async function previewSkillImport(
  input: { url: string; source_type?: SkillSourceType | null },
  options: SkillFetcher | SkillImportOptions = {},
): Promise<SkillImportPreview> {
  const fetcher = typeof options === "function"
    ? options
    : options.fetcher ?? defaultSkillFetcher;
  const commitResolver = typeof options === "function"
    ? null
    : options.commitResolver === undefined
      ? defaultGitHubCommitResolver
      : options.commitResolver;
  const packageLister = typeof options === "function"
    ? null
    : options.packageLister === undefined
      ? defaultGitHubPackageLister
      : options.packageLister;

  const source = normalizeSkillSourceUrl(input.url, input.source_type);
  const resolvedCommitSha =
    source.commitSha ?? (commitResolver ? await commitResolver(source.repo, source.ref).catch(() => null) : null);
  const stableRef = resolvedCommitSha ?? source.ref;
  const rawSkillUrl = rawGitHubUrl(source.repo, stableRef, source.skillPath);
  const commitResolution = source.commitSha
    ? "ref_is_commit"
    : resolvedCommitSha
      ? "resolved"
      : commitResolver
        ? "unresolved"
        : "disabled";

  const fetched = await fetcher(rawSkillUrl);
  assertTextContent(fetched.contentType ?? null, source.skillPath, "Skill source must be text content");
  assertByteLimit(fetched.body, MAX_SKILL_BYTES, "Skill source is too large");
  let rawContent = fetched.body;
  if (fetched.bytes) {
    try { rawContent = new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes); }
    catch { throw new HttpError(422, "SKILL.md must contain valid UTF-8 text"); }
  }
  const normalized = parseSkillMarkdown(rawContent, "SKILL.md");
  const declaredResources = declaredResourceMap(normalized.resources);

  const entries = await listPackageEntries({
    source,
    stableRef,
    resolvedCommitSha,
    packageLister,
  });
  const packageBuild = await buildPackageFiles({
    entries,
    source,
    stableRef,
    primaryContent: rawContent,
    primaryBytes: fetched.bytes,
    primaryContentType: fetched.contentType ?? null,
    declaredResources,
    fetcher,
  });
  return completeSkillPreview({
    source_type: "github", url: source.url, repo: source.repo, path: source.skillPath,
    ref: source.ref, commit_sha: resolvedCommitSha, content_hash: "",
    metadata_json: { normalized_from: source.kind, raw_url: rawSkillUrl,
      resolved_url: fetched.finalUrl ?? rawSkillUrl, commit_sha_resolution: commitResolution },
  }, rawContent, source.packageRoot, normalized, packageBuild);
}

/** The same immutable package path for a browser upload or an authorized Host read. */
export function previewSkillFiles(
  input: { files: Array<{ path: string; content_base64: string }>; source_type?: "upload" | "local_workspace"; source_metadata?: Record<string, unknown> },
): SkillImportPreview {
  return prepareSkillPackageFiles(input);
}

/** Pure package parsing, inventory and risk scan, also used for server-shipped bytes. */
export function prepareSkillPackageFiles(
  input: { files: Array<{ path: string; content_base64: string }>; source_type?: "upload" | "local_workspace" | "builtin"; source_metadata?: Record<string, unknown> },
): SkillImportPreview {
  // Finder/desktop metadata copied with a folder is not package content.
  const packageFiles = input.files.filter(file => !isPlatformMetadataPath(file.path));
  if (packageFiles.length === 0 || packageFiles.length > MAX_PACKAGE_FILES) throw new HttpError(422, "Skill package must contain 1–200 files");
  assertSkillPackagePaths(packageFiles.map(file => file.path));
  const all = new Map<string, Buffer>();
  let total = 0;
  for (const file of packageFiles) {
    validateRelativePackagePath(file.path, "Skill package file path is invalid");
    if (all.has(file.path)) throw new HttpError(422, "Skill package contains duplicate paths");
    const bytes = Buffer.from(file.content_base64, "base64");
    if (bytes.toString("base64") !== file.content_base64) throw new HttpError(422, "Skill file encoding is invalid");
    if (bytes.length > MAX_PACKAGE_TEXT_FILE_BYTES) throw new HttpError(413, "Skill package file is too large");
    total += bytes.length;
    if (total > MAX_PACKAGE_TOTAL_BYTES) throw new HttpError(413, "Skill package is too large");
    all.set(file.path, bytes);
  }
  const roots = [...all.keys()].filter(path => path === "SKILL.md" || path.endsWith("/SKILL.md"));
  if (roots.length !== 1) throw new HttpError(422, "Select one skill folder containing exactly one SKILL.md");
  const skillPath = roots[0]!;
  const root = dirname(skillPath);
  if ([...all.keys()].some(path => !pathWithinRoot(path, root))) throw new HttpError(422, "Files must belong to the selected skill folder");
  let markdown: string;
  try { markdown = new TextDecoder("utf-8", { fatal: true }).decode(all.get(skillPath)!); }
  catch { throw new HttpError(422, "SKILL.md must be UTF-8 text"); }
  const normalized = parseSkillMarkdown(markdown);
  const contents: Record<string, string> = Object.create(null);
  const files = [...all].map(([path, bytes]): SkillPackageFilePreview => {
    contents[path] = bytes.toString("base64");
    const kind = classifyPackageFile(path, root, skillPath);
    const executable = kind === "script" || EXECUTABLE_PATH_RE.test(path);
    return { path, kind, content_hash: createHash("sha256").update(bytes).digest("hex"),
      content_type: isTextPackagePath(path) ? "text/plain" : "application/octet-stream",
      byte_length: bytes.length, included: true, executable,
      risk_flags_json: executable ? { script: true, executable: true } : {} };
  }).sort((a, b) => a.path.localeCompare(b.path));
  return completeSkillPreview({ source_type: input.source_type ?? "upload", url: null, repo: null,
    path: skillPath, ref: null, commit_sha: null, content_hash: "",
    metadata_json: input.source_metadata ?? {},
  }, markdown, root, normalized, { files, contents, warnings: files.some(file => file.executable) ? ["script_files_detected"] : [] });
}

function completeSkillPreview(
  source: SkillImportPreview["source"], rawContent: string, packageRoot: string,
  normalized: ReturnType<typeof parseSkillMarkdown>,
  packageBuild: { files: SkillPackageFilePreview[]; warnings: string[]; contents: Record<string, string> },
): SkillImportPreview {
  const packageHash = hashPackageFiles(packageBuild.files);
  normalized.spec_kind = "agent_skills";
  normalized.spec_version = "2025-11-10";
  normalized.skill_root = packageRoot || ".";
  normalized.package_hash = packageHash;
  normalized.diagnostics = packageBuild.warnings;
  normalized.resources = resourcesFromPackageFiles(packageBuild.files, packageRoot);
  normalized.execution_profile = { ...normalized.execution_profile,
    scripts_present: packageBuild.files.some(file => file.executable),
    package_file_count: packageBuild.files.length, package_root: packageRoot || "." };
  const risk = analyzeSkillRisk(normalized);
  const warnings = uniqueSorted([...risk.warnings, ...packageBuild.warnings]);
  normalized.trust_analysis = { risk_level: risk.risk_level, warnings, signals: risk.signals };
  return {
    source: { ...source, content_hash: packageHash, metadata_json: { ...source.metadata_json,
      skill_path: source.path, package_root: packageRoot || ".", package_hash: packageHash,
      package_file_count: packageBuild.files.length,
      resource_policy: { max_package_files: MAX_PACKAGE_FILES, max_package_total_bytes: MAX_PACKAGE_TOTAL_BYTES,
        max_package_text_file_bytes: MAX_PACKAGE_TEXT_FILE_BYTES, same_repository_package_root_only: true,
        scripts_executed: false, dependencies_installed: false },
    } },
    normalized_skill: normalized, package_root: packageRoot || ".", package_hash: packageHash,
    package_files: packageBuild.files, risk_level: risk.risk_level, requested_permissions: risk.requested_permissions,
    files_detected: packageBuild.files.map(file => file.path), warnings, persistable: true,
    raw_content: rawContent, package_contents: packageBuild.contents,
  };
}

async function listPackageEntries(input: {
  source: NormalizedSource;
  stableRef: string;
  resolvedCommitSha: string | null;
  packageLister: SkillPackageLister | null;
}): Promise<SkillPackageTreeEntry[]> {
  const fallback = fallbackPackageEntries(input.source.skillPath);
  if (!input.packageLister) return fallback;
  const listed = await input.packageLister({
    repo: input.source.repo,
    ref: input.stableRef,
    commitSha: input.resolvedCommitSha,
    packageRoot: input.source.packageRoot,
    skillPath: input.source.skillPath,
  });
  const entries = listed
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({
      ...entry,
      path: normalizeRepoPath(entry.path, "Skill package file path is invalid"),
    }))
    .filter((entry) => pathWithinRoot(entry.path, input.source.packageRoot));
  if (!entries.some((entry) => entry.path === input.source.skillPath)) {
    entries.push(fallback[0]!);
  }
  const byPath = new Map<string, SkillPackageTreeEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);
  const out = [...byPath.values()].sort((a, b) => {
    if (a.path === input.source.skillPath) return -1;
    if (b.path === input.source.skillPath) return 1;
    return a.path.localeCompare(b.path);
  });
  if (out.length > MAX_PACKAGE_FILES) {
    throw new HttpError(422, "Skill package contains too many files");
  }
  assertSkillPackagePaths(out.map(file => file.path));
  return out;
}

function fallbackPackageEntries(skillPath: string): SkillPackageTreeEntry[] {
  return [{ path: skillPath, type: "blob", size: null, sha: null, mode: "100644" }];
}

async function buildPackageFiles(input: {
  entries: SkillPackageTreeEntry[];
  source: NormalizedSource;
  stableRef: string;
  primaryContent: string;
  primaryBytes?: Uint8Array;
  primaryContentType: string | null;
  declaredResources: Map<string, DeclaredResource>;
  fetcher: SkillFetcher;
}): Promise<{ files: SkillPackageFilePreview[]; warnings: string[]; contents: Record<string, string> }> {
  const files: SkillPackageFilePreview[] = [];
  const contents: Record<string, string> = Object.create(null);
  const warnings = new Set<string>();
  let totalBytes = 0;

  for (const entry of input.entries) {
    const relativePath = toPackageRelativePath(entry.path, input.source.packageRoot);
    const kind =
      input.declaredResources.get(relativePath)?.kind ??
      classifyPackageFile(entry.path, input.source.packageRoot, input.source.skillPath);
    const executable = Boolean(entry.executable) || kind === "script" || EXECUTABLE_PATH_RE.test(entry.path);
    const riskFlags: Record<string, unknown> = {};
    if (kind === "script") {
      riskFlags.script = true;
      warnings.add("script_files_detected");
    }
    if (executable) riskFlags.executable = true;

    const shouldFetchText = entry.path === input.source.skillPath || kind === "script" || isTextPackagePath(entry.path);
    if (entry.mode === "120000" || entry.mode === "160000") throw new HttpError(422, "Skill packages cannot contain symlinks or submodules");

    const fetched = entry.path === input.source.skillPath
      ? {
          body: input.primaryContent,
          bytes: input.primaryBytes,
          contentType: input.primaryContentType,
          finalUrl: rawGitHubUrl(input.source.repo, input.stableRef, entry.path),
        }
      : await input.fetcher(rawGitHubUrl(input.source.repo, input.stableRef, entry.path));
    assertAllowedFetchHost(fetched.finalUrl ?? rawGitHubUrl(input.source.repo, input.stableRef, entry.path));
    if (shouldFetchText) assertTextContent(
      fetched.contentType ?? null,
      entry.path,
      "Skill package file must be text content or a declared non-text asset",
    );
    const bytes = Buffer.from("bytes" in fetched && fetched.bytes ? fetched.bytes : Buffer.from(fetched.body, "utf8"));
    const byteLength = bytes.byteLength;
    if (byteLength > MAX_PACKAGE_TEXT_FILE_BYTES) throw new HttpError(413, "Skill package file is too large");
    totalBytes += byteLength;
    if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
      throw new HttpError(413, "Skill package is too large");
    }

    files.push({
      path: entry.path,
      kind,
      content_hash: createHash("sha256").update(bytes).digest("hex"),
      content_type: fetched.contentType ?? entry.contentType ?? null,
      byte_length: byteLength,
      included: true,
      executable,
      risk_flags_json: riskFlags,
    });
    contents[entry.path] = bytes.toString("base64");
  }

  return { files, warnings: [...warnings].sort((a, b) => a.localeCompare(b)), contents };
}

function resourcesFromPackageFiles(
  files: SkillPackageFilePreview[],
  packageRoot: string,
): NormalizedSkillResource[] {
  return files.map((file) => ({
    path: toPackageRelativePath(file.path, packageRoot),
    kind: file.kind,
    content_hash: file.content_hash,
    content_type: file.content_type,
    byte_length: file.byte_length,
  }));
}

interface DeclaredResource {
  kind: string;
  description?: string | null;
}

function declaredResourceMap(resources: NormalizedSkillResource[]): Map<string, DeclaredResource> {
  const out = new Map<string, DeclaredResource>();
  for (const resource of resources) {
    if (resource.kind === "skill_markdown") continue;
    validateRelativePackagePath(resource.path, "Optional skill resource path is invalid");
    out.set(resource.path, {
      kind: resource.kind,
      description: resource.description,
    });
  }
  return out;
}

function classifyPackageFile(path: string, packageRoot: string, skillPath: string): string {
  if (path === skillPath) return "skill_markdown";
  const relative = toPackageRelativePath(path, packageRoot);
  const first = relative.split("/")[0]?.toLowerCase() ?? "";
  if (first === "scripts") return "script";
  if (first === "references" || first === "reference") return "reference";
  if (first === "assets" || first === "asset") return "asset";
  if (/^licen[cs]e(\.|$)|^copying(\.|$)|^notice(\.|$)/i.test(relative)) return "license";
  if (/^readme(\.|$)/i.test(relative)) return "reference";
  return "supporting_file";
}

function isTextPackagePath(path: string): boolean {
  return path.endsWith("SKILL.md") || TEXT_RESOURCE_PATH_RE.test(path);
}

function hashPackageFiles(files: SkillPackageFilePreview[]): string {
  return sha256(
    JSON.stringify(
      files
        .map((file) => ({
          path: file.path,
          kind: file.kind,
          content_hash: file.content_hash ?? null,
          byte_length: file.byte_length ?? null,
          included: file.included,
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  );
}

interface NormalizedSource {
  kind: "github_blob" | "github_tree" | "raw_github";
  url: string;
  repo: string;
  skillPath: string;
  packageRoot: string;
  ref: string;
  commitSha: string | null;
}

function normalizeSkillSourceUrl(
  raw: string,
  sourceType?: SkillSourceType | null,
): NormalizedSource {
  if (sourceType && sourceType !== "github") {
    throw new HttpError(422, "unsupported_skill_source");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, "Skill source URL is invalid");
  }
  if (url.protocol !== "https:") throw new HttpError(422, "Skill source URL must use HTTPS");

  if (url.hostname === "raw.githubusercontent.com") {
    const parts = cleanParts(url.pathname);
    if (parts.length < 4) throw new HttpError(422, "GitHub raw URL must include owner, repo, ref, and SKILL.md path");
    const [owner, repo, ref, ...pathParts] = parts;
    const skillPath = normalizeSkillPath(pathParts.join("/"));
    return {
      kind: "raw_github",
      url: url.toString(),
      repo: `${owner}/${repo}`,
      ref,
      skillPath,
      packageRoot: dirname(skillPath),
      commitSha: commitSha(ref),
    };
  }

  if (url.hostname !== "github.com") throw new HttpError(422, "unsupported_skill_source");
  const parts = cleanParts(url.pathname);
  if (parts.length < 4) throw new HttpError(422, "GitHub URL must point to a SKILL.md file or skill folder");
  const [owner, repo, mode, ref, ...pathParts] = parts;
  if (mode !== "blob" && mode !== "tree") throw new HttpError(422, "GitHub URL must be a blob or tree URL");
  if (mode === "blob" && pathParts.length === 0) {
    throw new HttpError(422, "GitHub blob URL must point to a SKILL.md file");
  }
  const requestedPath = pathParts.length > 0
    ? normalizeRepoPath(pathParts.join("/"), "Skill source path is invalid")
    : "";
  const packageRoot = mode === "tree" ? normalizePackageRoot(requestedPath) : dirname(normalizeSkillPath(requestedPath));
  const skillPath = mode === "tree" ? joinSkillPath(packageRoot) : normalizeSkillPath(requestedPath);
  return {
    kind: mode === "tree" ? "github_tree" : "github_blob",
    url: url.toString(),
    repo: `${owner}/${repo}`,
    ref,
    skillPath,
    packageRoot,
    commitSha: commitSha(ref),
  };
}

function cleanParts(pathname: string): string[] {
  return pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new HttpError(422, "Skill source URL is invalid");
      }
    })
    .filter(Boolean);
}

function normalizeRepoPath(path: string, message: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  validateRelativePackagePath(clean, message);
  return clean;
}

function normalizePackageRoot(path: string): string {
  if (!path) return "";
  return normalizeRepoPath(path, "Skill package root is invalid");
}

function normalizeSkillPath(path: string): string {
  const clean = normalizeRepoPath(path, "Skill source path is invalid");
  if (!clean.endsWith("SKILL.md")) {
    throw new HttpError(422, "GitHub import requires a SKILL.md file or containing folder");
  }
  return clean;
}

function validateRelativePackagePath(path: string, message: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) {
    throw new HttpError(422, message);
  }
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(422, message);
  }
}

function pathWithinRoot(path: string, root: string): boolean {
  if (!root) return true;
  return path.startsWith(`${root}/`);
}

function toPackageRelativePath(path: string, packageRoot: string): string {
  if (!packageRoot) return path;
  return path.startsWith(`${packageRoot}/`) ? path.slice(packageRoot.length + 1) : path;
}

function joinSkillPath(path: string): string {
  return path ? `${path}/SKILL.md` : "SKILL.md";
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function rawGitHubUrl(repo: string, ref: string, path: string): string {
  // Tree paths and the decoded skill path are file names, not URL text: a
  // `#` would end the URL, a `?` start a query, a bare `%` fail to parse.
  const encoded = (value: string) => value.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${repo}/${encoded(ref)}/${encoded(path)}`;
}

function assertTextContent(contentType: string | null, path: string, message: string): void {
  if (contentType && !TEXT_RESOURCE_RE.test(contentType)) {
    throw new HttpError(415, message);
  }
  if (!contentType && !isTextPackagePath(path)) {
    throw new HttpError(415, message);
  }
}

function assertByteLimit(text: string, maxBytes: number, message: string): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new HttpError(413, message);
  }
}

function commitSha(ref: string): string | null {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref : null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
