import { createHash } from "node:crypto";
import { normalizeReaderText } from "../reader/repository.js";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };

export function buildResearchReportReaderProjection(report: Record<string, unknown>) {
  const labels = referenceLabels(report);
  const nodes: Node[] = [];
  const lines: string[] = [];
  let referenceIndex = 0;
  const heading = (level: number, value: string) => { nodes.push({ type: "heading", attrs: { level }, content: [{ type: "text", text: value }] }); lines.push(value); };
  const paragraph = (value: unknown) => {
    const text = typeof value === "string" ? rewriteInlineCitations(value.trim(), labels) : "";
    if (!text) return;
    nodes.push({ type: "paragraph", content: [{ type: "text", text }] }); lines.push(text);
  };
  const refs = (value: unknown) => {
    if (!Array.isArray(value) || value.length === 0) return;
    const entryLabels = value.map((entry) => referenceLabel(entry, ++referenceIndex));
    paragraph(`References: ${[...new Set(entryLabels)].map((label) => `[${label}]`).join("; ")}`);
  };

  heading(1, "Research report");
  paragraph(report.research_question);
  heading(2, "Executive summary"); paragraph(report.summary);
  heading(2, "Findings");
  for (const item of records(report.findings)) { heading(3, string(item.claim, "Finding")); paragraph(item.support); refs(item.references); }
  heading(2, "Sources");
  for (const item of records(report.sources)) {
    heading(3, string(item.title, "Untitled source"));
    const authors = Array.isArray(item.authors) ? item.authors.filter((v): v is string => typeof v === "string") : [];
    paragraph([authors.join(", "), typeof item.year === "number" ? String(item.year) : "", string(item.relevance)].filter(Boolean).join(" · "));
    paragraph(item.summary); refs(item.references);
  }
  heading(2, "Limitations"); for (const item of strings(report.limitations)) paragraph(item);
  heading(2, "Research ideas");
  for (const item of records(report.ideas)) {
    heading(3, string(item.title, "Untitled idea")); paragraph(`Problem: ${string(item.problem)}`);
    paragraph(`Novelty: ${string(item.novelty)}`); paragraph(`Testability: ${string(item.testability)}`); refs(item.references);
  }
  const normalizedText = normalizeReaderText(lines.join("\n\n"));
  return {
    readerDocument: { type: "doc", content: nodes },
    normalizedText,
    contentHash: createHash("sha256").update(normalizedText, "utf8").digest("hex"),
  };
}

/**
 * Label for one reference entry: the persistent `reference_id` written at
 * materialization when present, else the positional "ref-N" fallback used
 * for reports stored before two-level numbering existed. The positional
 * counting must mirror the refs() render order above (findings, then
 * sources, then ideas, counting every array element) — the same order the
 * reference resolver's fallback assigns.
 */
function referenceLabel(entry: unknown, positionalIndex: number): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const id = (entry as Record<string, unknown>).reference_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return `ref-${positionalIndex}`;
}

/** Maps every identifier declared in the report's reference entries to its entry label. */
function referenceLabels(report: Record<string, unknown>): Map<string, string> {
  const labels = new Map<string, string>();
  let index = 0;
  for (const section of [report.findings, report.sources, report.ideas]) {
    for (const item of records(section)) {
      if (!Array.isArray(item.references)) continue;
      for (const ref of item.references) {
        index += 1;
        if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
        const label = referenceLabel(ref, index);
        for (const [key, value] of Object.entries(ref as Record<string, unknown>)) {
          if (key === "reference_id") continue;
          const id = typeof value === "string" ? value.trim() : "";
          if (id && !labels.has(id)) labels.set(id, label);
        }
      }
    }
  }
  return labels;
}

/**
 * Synthesis prose may carry inline citation groups holding the raw corpus
 * ids the model saw (e.g. "[fc880096, 8fa13ba8]"). Rewrite tokens that match
 * a declared reference (exactly, or as an id prefix — models truncate UUIDs)
 * to the "ref-N" labels of the References panel, so raw identifiers never
 * reach readers. Groups with no recognizable token are left untouched.
 */
function rewriteInlineCitations(text: string, labels: Map<string, string>): string {
  if (labels.size === 0) return text;
  return text.replace(/\[([^\[\]]+)\]/g, (group, inner: string) => {
    const tokens = inner.split(",").map((token) => token.trim());
    if (tokens.length === 0 || !tokens.every((token) => /^[0-9a-z][0-9a-z./_-]{3,63}$/i.test(token))) return group;
    const mapped = tokens.map((token) => citationLabel(token, labels));
    if (!mapped.some(Boolean)) return group;
    const rendered = [...new Set(mapped.map((label, i) => label ?? tokens[i]!))];
    return `[${rendered.join(", ")}]`;
  });
}

function citationLabel(token: string, labels: Map<string, string>): string | null {
  const exact = labels.get(token);
  if (exact) return exact;
  if (token.length < 8) return null;
  const matched = new Set<string>();
  for (const [id, label] of labels) {
    if (id.startsWith(token) || (id.length >= 8 && token.startsWith(id))) matched.add(label);
  }
  return matched.size === 1 ? [...matched][0]! : null;
}

function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v))) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function string(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
