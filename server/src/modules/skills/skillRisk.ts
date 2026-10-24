import type { NormalizedSkill, SkillRiskAnalysis, SkillRiskLevel } from "./types.js";

const HIGH_TOOL_RE = /\b(bash|shell|sh|zsh|fish|powershell|terminal|subprocess|exec|python|node|npm|pnpm|pip|uv|cargo|docker)\b/i;
const NETWORK_RE = /\b(web|network|http|https|fetch|curl|wget|search|browser|url|rss)\b/i;
const SECRET_RE = /\b(secret|credential|token|api[_ -]?key|password|oauth|ssh key|private key)\b/i;
const SCRIPT_RE = /\b(script|scripts|install|postinstall|run command|execute command|chmod|makefile)\b/i;
const MCP_RE = /\b(mcp|model context protocol)\b/i;
const MEMORY_WRITE_RE = /\b(write|update|store|save)\b.{0,40}\b(memory|memories|long[- ]term memory)\b/i;
const SAFE_PERMISSION_RE = /^(read|write|edit|webfetch|websearch|search|network|filesystem|file|grep|glob)$/i;

export function analyzeSkillRisk(skill: NormalizedSkill): SkillRiskAnalysis {
  const warnings: string[] = [];
  const signals: string[] = [];
  const requested = [...new Set(skill.requested_permissions.map((item) => item.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  let risk: SkillRiskLevel = "low";

  const corpus = [
    skill.instructions_markdown,
    JSON.stringify(skill.execution_profile),
    JSON.stringify(skill.vendor_extensions),
    requested.join(" "),
  ].join("\n");

  if (SCRIPT_RE.test(corpus) || skill.execution_profile.scripts_present === true) {
    risk = maxRisk(risk, "high");
    warnings.push("script_or_dependency_hint_detected");
    signals.push("scripts");
  }
  if (requested.some((permission) => HIGH_TOOL_RE.test(permission)) || HIGH_TOOL_RE.test(corpus)) {
    risk = maxRisk(risk, "high");
    warnings.push("shell_or_subprocess_permission_requested");
    signals.push("shell");
  }
  if (SECRET_RE.test(corpus)) {
    const critical = /\b(exfiltrate|export|send|upload|leak)\b.{0,60}\b(secret|credential|token|api[_ -]?key|password|private key)\b/i.test(corpus);
    risk = maxRisk(risk, critical ? "critical" : "high");
    warnings.push(critical ? "credential_exfiltration_language_detected" : "credential_or_secret_language_detected");
    signals.push("credentials");
  }
  if (NETWORK_RE.test(corpus)) {
    risk = maxRisk(risk, "medium");
    warnings.push("network_or_search_access_requested");
    signals.push("network");
  }
  if (MCP_RE.test(corpus)) {
    risk = maxRisk(risk, "high");
    warnings.push("mcp_dependency_requested");
    signals.push("mcp");
  }
  if (MEMORY_WRITE_RE.test(corpus)) {
    risk = maxRisk(risk, "high");
    warnings.push("direct_memory_write_claim_detected");
    signals.push("memory_write_claim");
  }
  if (requested.some((permission) => !SAFE_PERMISSION_RE.test(permission))) {
    risk = maxRisk(risk, "medium");
    warnings.push("unknown_vendor_tool_declaration_detected");
    signals.push("unknown_tool");
  }

  return {
    risk_level: risk,
    warnings: [...new Set(warnings)].sort((a, b) => a.localeCompare(b)),
    requested_permissions: requested,
    signals: [...new Set(signals)].sort((a, b) => a.localeCompare(b)),
  };
}

function maxRisk(a: SkillRiskLevel, b: SkillRiskLevel): SkillRiskLevel {
  const order: SkillRiskLevel[] = ["low", "medium", "high", "critical"];
  return order.indexOf(b) > order.indexOf(a) ? b : a;
}

