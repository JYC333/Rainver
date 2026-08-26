import { createHash } from "node:crypto";
import { fetch } from "undici";
import { HttpError } from "../routeUtils/common.js";
import { parseSkillMarkdown } from "./skillParser.js";
import { analyzeSkillRisk } from "./skillRisk.js";
import type {
  NormalizedSkillResource,
  SkillImportPreview,
  SkillPackageFilePreview,
  SkillSourceType,
} from "./types.js";

export interface SkillFetcher {
  (url: string): Promise<{ body: string; finalUrl?: string | null; contentType?: string | null }>;
}

export interface SkillCommitResolver {
  (repo: string, ref: string): Promise<string | null>;
}

export interface SkillPackageListSource {
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

export const defaultSkillFetcher: SkillFetcher = async (url) => {
  assertAllowedFetchHost(url);
  const response = await fetch(url, { method: "GET", redirect: "follow" });
  if (!response.ok) {
    throw new HttpError(response.status, `Skill source fetch failed with HTTP ${response.status}`);
  }
  // Re-validate after redirects so a 3xx cannot pull content from a
  // non-allowlisted (e.g. private-network) host.
  if (response.url) assertAllowedFetchHost(response.url);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/text|markdown|plain|json|yaml|octet-stream/i.test(contentType)) {
    throw new HttpError(415, "Skill source must be text content");
  }
  return { body: await response.text(), finalUrl: response.url, contentType };
};

export const defaultGitHubCommitResolver: SkillCommitResolver = async (repo, ref) => {
  if (commitSha(ref)) return ref;
  const response = await fetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "rainver-skill-import",
      },
      redirect: "follow",
    },
  );
  if (!response.ok) return null;
  const parsed = (await response.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const sha = (parsed as { sha?: unknown }).sha;
  return typeof sha === "string" && commitSha(sha) ? sha : null;
};

export const defaultGitHubPackageLister: SkillPackageLister = async (source) => {
  const treeish =
    source.commitSha ? await resolveGitHubTreeSha(source.repo, source.commitSha) : source.ref;
  const response = await fetch(
    `https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "rainver-skill-import",
      },
      redirect: "follow",
    },
  );
  if (!response.ok) {
    throw new HttpError(response.status, `Skill package tree fetch failed with HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as unknown;
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
  const response = await fetch(
    `https://api.github.com/repos/${repo}/git/commits/${encodeURIComponent(commitShaValue)}`,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "rainver-skill-import",
      },
      redirect: "follow",
    },
  );
  if (!response.ok) return commitShaValue;
  const parsed = (await response.json()) as unknown;
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
  const rawContent = fetched.body;
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
    primaryContentType: fetched.contentType ?? null,
    declaredResources,
    fetcher,
  });
  const packageHash = hashPackageFiles(packageBuild.files);

  normalized.spec_kind = "agent_skills";
  normalized.spec_version = "2025-11-10";
  normalized.skill_root = source.packageRoot || ".";
  normalized.package_hash = packageHash;
  normalized.diagnostics = packageBuild.warnings;
  normalized.resources = resourcesFromPackageFiles(packageBuild.files, source.packageRoot);
  normalized.execution_profile = {
    ...normalized.execution_profile,
    scripts_present: packageBuild.files.some((file) => file.kind === "script"),
    package_file_count: packageBuild.files.length,
    package_root: source.packageRoot || ".",
  };

  const risk = analyzeSkillRisk(normalized);
  const warnings = uniqueSorted([...risk.warnings, ...packageBuild.warnings]);
  normalized.trust_analysis = {
    risk_level: risk.risk_level,
    warnings,
    signals: risk.signals,
  };

  return {
    source: {
      source_type: "github",
      url: source.url,
      repo: source.repo,
      path: source.skillPath,
      ref: source.ref,
      commit_sha: resolvedCommitSha,
      content_hash: packageHash,
      metadata_json: {
        normalized_from: source.kind,
        raw_url: rawSkillUrl,
        resolved_url: fetched.finalUrl ?? rawSkillUrl,
        commit_sha_resolution: commitResolution,
        skill_path: source.skillPath,
        package_root: source.packageRoot || ".",
        package_hash: packageHash,
        package_file_count: packageBuild.files.length,
        resource_policy: {
          max_package_files: MAX_PACKAGE_FILES,
          max_package_total_bytes: MAX_PACKAGE_TOTAL_BYTES,
          max_package_text_file_bytes: MAX_PACKAGE_TEXT_FILE_BYTES,
          same_repository_package_root_only: true,
          scripts_executed: false,
          dependencies_installed: false,
        },
      },
    },
    normalized_skill: normalized,
    package_root: source.packageRoot || ".",
    package_hash: packageHash,
    package_files: packageBuild.files,
    risk_level: risk.risk_level,
    requested_permissions: risk.requested_permissions,
    files_detected: packageBuild.files.map((file) => file.path),
    warnings,
    persistable: true,
    raw_content: rawContent,
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
  primaryContentType: string | null;
  declaredResources: Map<string, DeclaredResource>;
  fetcher: SkillFetcher;
}): Promise<{ files: SkillPackageFilePreview[]; warnings: string[] }> {
  const files: SkillPackageFilePreview[] = [];
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
    if (!shouldFetchText) {
      riskFlags.binary_or_unsupported = true;
      warnings.add("binary_or_unsupported_files_detected");
      files.push({
        path: entry.path,
        kind,
        content_hash: entry.sha ? `git:${entry.sha}` : null,
        content_type: entry.contentType ?? null,
        byte_length: entry.size ?? null,
        included: false,
        executable,
        risk_flags_json: riskFlags,
      });
      continue;
    }

    const fetched = entry.path === input.source.skillPath
      ? {
          body: input.primaryContent,
          contentType: input.primaryContentType,
          finalUrl: rawGitHubUrl(input.source.repo, input.stableRef, entry.path),
        }
      : await input.fetcher(rawGitHubUrl(input.source.repo, input.stableRef, entry.path));
    assertAllowedFetchHost(fetched.finalUrl ?? rawGitHubUrl(input.source.repo, input.stableRef, entry.path));
    assertTextContent(
      fetched.contentType ?? null,
      entry.path,
      "Skill package file must be text content or a declared non-text asset",
    );
    assertByteLimit(fetched.body, MAX_PACKAGE_TEXT_FILE_BYTES, "Skill package text file is too large");
    const byteLength = Buffer.byteLength(fetched.body, "utf8");
    totalBytes += byteLength;
    if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
      throw new HttpError(413, "Skill package is too large");
    }

    files.push({
      path: entry.path,
      kind,
      content_hash: sha256(fetched.body),
      content_type: fetched.contentType ?? entry.contentType ?? null,
      byte_length: byteLength,
      included: true,
      executable,
      risk_flags_json: riskFlags,
    });
  }

  return { files, warnings: [...warnings].sort((a, b) => a.localeCompare(b)) };
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
  if (!path || path.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/")) {
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
  return `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
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
