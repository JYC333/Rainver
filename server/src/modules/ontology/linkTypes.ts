import type { LinkType } from "@agent-space/protocol" with { "resolution-mode": "import" };

/**
 * Link Type declarations: legal endpoints and governance, per edge type.
 *
 * ADR 0012 decision 3 — governance is a property of the **edge**, not of the
 * table. `Thread decomposes_into Thread` is a structural action a user takes
 * directly; `Claim contradicts Claim` is a semantic assertion that needs
 * review. Expressing that as "which table the row lives in" is what produced
 * the duplicate `inquiry_thread_relations` table in the first place.
 *
 * B12F — this lives in code, not in per-space data, because each declaration
 * has to be honoured by an implementation: a `proposal` link type needs an
 * applier, and no configuration row can conjure one. The registry is open for
 * modules (including plugins) to register into at boot, which is what keeps
 * "definitions in code" from meaning "only the core team can extend".
 */

export type LinkGovernance =
  /** Written directly by the owning domain service. */
  | "direct"
  /** Canonical write goes through the proposal flow. */
  | "proposal";

export interface LinkTypeDefinition {
  linkType: LinkType;
  /**
   * Object types allowed at each end. `"any"` means any registered entity —
   * used by the generic association types that predate this registry.
   */
  from: readonly string[] | "any";
  to: readonly string[] | "any";
  governance: LinkGovernance;
  /** Whether an active edge of this type is projected into retrieval. */
  retrievalProjected: boolean;
  /** Module that registered it, for attribution in diagnostics. */
  owner: string;
}

// A link type may carry several declarations, because the same word means
// different things in different domains: `supports` between two Threads is
// working structure a user drags into place, while `supports` between two
// Claims is a reviewed assertion. Keying governance on the word alone would
// force one of them to change behaviour (ADR 0012 decision 3, amended).
const registry = new Map<LinkType, LinkTypeDefinition[]>();

function endpointsOverlap(a: LinkTypeDefinition, b: LinkTypeDefinition): boolean {
  const sideOverlaps = (x: readonly string[] | "any", y: readonly string[] | "any"): boolean =>
    x === "any" || y === "any" || x.some((value) => y.includes(value));
  return sideOverlaps(a.from, b.from) && sideOverlaps(a.to, b.to);
}

export function registerLinkType(definition: LinkTypeDefinition): void {
  const existing = registry.get(definition.linkType) ?? [];
  for (const other of existing) {
    if (other.owner === definition.owner && other.from === definition.from && other.to === definition.to) {
      registry.set(definition.linkType, existing.map((entry) => (entry === other ? definition : entry)));
      return;
    }
    // Two declarations that can both match the same edge would make governance
    // depend on registration order, which is exactly the ambiguity this
    // registry exists to remove. Specific-versus-`any` is fine; the resolver
    // prefers the specific one.
    const bothSpecific = definition.from !== "any" && definition.to !== "any"
      && other.from !== "any" && other.to !== "any";
    if (bothSpecific && endpointsOverlap(definition, other)) {
      throw new Error(
        `Link type ${definition.linkType} already has an overlapping declaration from ${other.owner}`,
      );
    }
  }
  registry.set(definition.linkType, [...existing, definition]);
}

/**
 * The declaration governing an edge. The most specific endpoint match wins; an
 * `any`/`any` declaration is the fallback. Called without endpoints it returns
 * a declaration only when the link type has exactly one.
 */
export function linkTypeDefinition(
  linkType: string,
  fromObjectType?: string | null,
  toObjectType?: string | null,
): LinkTypeDefinition | null {
  const declarations = registry.get(linkType as LinkType);
  if (!declarations || declarations.length === 0) return null;
  if (declarations.length === 1) return declarations[0]!;
  if (!fromObjectType && !toObjectType) return null;

  const accepts = (side: readonly string[] | "any", value?: string | null): boolean =>
    side === "any" || !value || side.includes(value);
  const matching = declarations.filter(
    (declaration) => accepts(declaration.from, fromObjectType) && accepts(declaration.to, toObjectType),
  );
  if (matching.length === 0) return null;
  const specific = matching.filter((d) => d.from !== "any" || d.to !== "any");
  return (specific[0] ?? matching[0])!;
}

export function registeredLinkTypes(): readonly LinkTypeDefinition[] {
  return [...registry.values()].flat();
}


/**
 * Core declarations. Governance follows the pre-existing behaviour: everything
 * that `object_relations` already gated behind a proposal stays gated, and the
 * two types recovered from `inquiry_thread_relations` keep the direct writes
 * they had as a domain table.
 */
function registerCoreLinkTypes(): void {
  const proposalGated: readonly LinkType[] = [
    "related_to",
    "references",
    "same_as",
    "part_of",
    "depends_on",
    "source_for",
    "derived_from",
    "cites",
    "summarizes",
    "about",
    "explains",
    "example_of",
    "applies_to",
    "supports",
    "contradicts",
    "supersedes",
    "refines",
    "updates",
    "prerequisite_of",
  ];
  for (const linkType of proposalGated) {
    registerLinkType({
      linkType,
      from: "any",
      to: "any",
      governance: "proposal",
      retrievalProjected: true,
      owner: "ontology",
    });
  }

  // Endpoint constraints that used to be hardcoded in the proposal applier.
  // Declaring them here is what makes the registry authoritative rather than
  // advisory — the applier now asks instead of re-stating them.
  registerLinkType({
    linkType: "affiliated_with",
    from: ["person"],
    to: ["organization"],
    governance: "proposal",
    retrievalProjected: true,
    owner: "relations",
  });
  registerLinkType({
    linkType: "authored_by",
    from: ["source"],
    to: ["person"],
    governance: "proposal",
    retrievalProjected: true,
    owner: "relations",
  });

  // Recovered from `inquiry_thread_relations` (ADR 0011 decision 3). Thread
  // structure is a direct user action at editing frequency; routing it through
  // proposals would be a behaviour change, not a refactor. Five of these words
  // are also Knowledge/Claim link types where they are reviewed assertions —
  // the endpoint-specific declaration is what lets both keep their behaviour.
  for (const linkType of [
    "decomposes_into",
    "proposes",
    "depends_on",
    "supports",
    "contradicts",
    "supersedes",
    "related_to",
  ] as const) {
    registerLinkType({
      linkType,
      from: ["inquiry_thread"],
      to: ["inquiry_thread"],
      governance: "direct",
      retrievalProjected: true,
      owner: "inquiry",
    });
  }

  // Recovered from `decision_case_sources`: a cross-aggregate reference between
  // Project-owned objects, direct-write like the domain table it replaces.
  // `experiment_definitions.primary_hypothesis_thread_id` stays a column — it
  // is a single required pointer with its own FK, not a set of links.
  registerLinkType({
    linkType: "derived_from",
    from: ["decision_case"],
    to: ["inquiry_thread"],
    governance: "direct",
    retrievalProjected: true,
    owner: "decisions",
  });

  // A focused Research Workflow is about its pinned Inquiry Thread. This is
  // single-valued domain structure, so the endpoint-specific declaration is
  // direct even though generic `about` assertions remain proposal-gated.
  registerLinkType({
    linkType: "about",
    from: ["research_workflow"],
    to: ["inquiry_thread"],
    governance: "direct",
    retrievalProjected: true,
    owner: "projectResearch",
  });

  // Thread-to-Note working links, recovered from `inquiry_thread_note_links`.
  registerLinkType({
    linkType: "references",
    from: ["inquiry_thread"],
    to: ["note"],
    governance: "direct",
    retrievalProjected: true,
    owner: "inquiry",
  });
}

registerCoreLinkTypes();

/**
 * Whether a protocol vocabulary value has a declaration here. The protocol
 * package is ESM and this server is CJS, so the vocabulary is not imported at
 * runtime; a test dynamically imports it and asserts the two agree, which also
 * keeps the contract package free of behaviour.
 */
export function hasDeclaration(linkType: string): boolean {
  return registry.has(linkType as LinkType);
}
