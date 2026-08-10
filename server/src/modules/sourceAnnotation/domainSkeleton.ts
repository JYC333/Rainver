/**
 * The domain skeleton: the reference frame serendipity gaps are computed
 * against.
 *
 * The load-bearing property is that this list is **independent of the reader**.
 * Computing "what have I not encountered" against the reader's own coverage
 * distribution can only ever draw from material their own sources already
 * surfaced, and the source pool is itself a product of their interests — the
 * ceiling is the bubble. Against a fixed external frame, "you cover 12 of 60
 * domains" holds on day one and needs no history at all, which is also why cold
 * start stops being a special case.
 *
 * This is deliberately the opposite of the topic axis in the interest profile.
 * There, a fixed taxonomy would *be* the bubble, so topics grow under control
 * from what the reader actually reads. Here, a fixed taxonomy is the point.
 * Both statements are true because they act on different things: the skeleton
 * is coarse, code-owned, and about the world; the topic axis is fine, user
 * data, and about the person. Topics map onto domains, so "which cells are
 * occupied" is a join rather than a second classification.
 *
 * B12F/ADR 0012 — definitions live in code, in a registry modules register
 * into at boot, not in per-space rows. A domain has to be honoured by the
 * annotation prompt and by gap computation; no configuration row can conjure
 * either.
 *
 * Granularity is intentionally coarse. A fine-grained skeleton produces
 * fake gaps: split "machine learning" into forty subfields and a reader who
 * follows the field daily still shows thirty-eight "uncovered" cells, and the
 * serendipity quota spends itself re-surfacing what they already read.
 */

export type DomainGroup =
  | "science"
  | "technology"
  | "health"
  | "society"
  | "economy"
  | "culture"
  | "environment"
  | "practice";

export interface DomainDefinition {
  /** Stable identifier. Persisted on annotations; never renamed in place. */
  key: string;
  /** Human-readable label, used in prompts and in "why you are seeing this". */
  label: string;
  /** Coarse grouping, used to compute adjacency (see `adjacentDomainKeys`). */
  group: DomainGroup;
  /**
   * A short disambiguator for the annotation prompt. Domains at this
   * granularity have overlapping names in ordinary language ("media" versus
   * "arts", "economics" versus "business"), and an unguided model distributes
   * the same material differently between runs, which silently corrupts the
   * coverage distribution the serendipity quota reads.
   */
  hint: string;
  /** Module that registered it, for attribution in diagnostics. */
  owner: string;
}

const DOMAIN_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const registry = new Map<string, DomainDefinition>();

export function registerDomain(definition: DomainDefinition): void {
  if (!DOMAIN_KEY_PATTERN.test(definition.key)) {
    throw new Error(`invalid domain key ${JSON.stringify(definition.key)}`);
  }
  if (!definition.label.trim()) throw new Error(`domain ${definition.key} needs a label`);
  if (!definition.hint.trim()) throw new Error(`domain ${definition.key} needs a hint`);
  const existing = registry.get(definition.key);
  if (existing && existing.owner !== definition.owner) {
    throw new Error(
      `domain ${definition.key} is already registered by ${existing.owner}; pick another key`,
    );
  }
  registry.set(definition.key, definition);
}

export function domainDefinitions(): readonly DomainDefinition[] {
  return [...registry.values()];
}

export function domainKeys(): ReadonlySet<string> {
  return new Set(registry.keys());
}

export function getDomain(key: string): DomainDefinition | null {
  return registry.get(key) ?? null;
}

export function isKnownDomain(key: unknown): key is string {
  return typeof key === "string" && registry.has(key);
}

/**
 * Domains in the same group as any covered domain, excluding the covered ones.
 *
 * This is what fills the `adjacent` serendipity slots. Adjacency is by group
 * rather than by a similarity score on purpose: a score would need embeddings
 * or a model call to compute something that changes about once a year, and it
 * would make "why you are seeing this" unexplainable.
 */
export function adjacentDomainKeys(coveredKeys: Iterable<string>): string[] {
  const covered = new Set(coveredKeys);
  const groups = new Set<DomainGroup>();
  for (const key of covered) {
    const domain = registry.get(key);
    if (domain) groups.add(domain.group);
  }
  return domainDefinitions()
    .filter((domain) => groups.has(domain.group) && !covered.has(domain.key))
    .map((domain) => domain.key);
}

/** Domains sharing no group with anything covered — the `distant` slot pool. */
export function distantDomainKeys(coveredKeys: Iterable<string>): string[] {
  const covered = new Set(coveredKeys);
  const groups = new Set<DomainGroup>();
  for (const key of covered) {
    const domain = registry.get(key);
    if (domain) groups.add(domain.group);
  }
  return domainDefinitions()
    .filter((domain) => !groups.has(domain.group) && !covered.has(domain.key))
    .map((domain) => domain.key);
}

const BUILTIN_DOMAINS: readonly Omit<DomainDefinition, "owner">[] = [
  // science
  { key: "mathematics", label: "Mathematics", group: "science", hint: "pure and applied mathematics, statistics as a discipline" },
  { key: "physics", label: "Physics", group: "science", hint: "physics, astronomy, cosmology, materials at the physical level" },
  { key: "chemistry", label: "Chemistry", group: "science", hint: "chemistry, materials science, chemical engineering" },
  { key: "biology", label: "Biology", group: "science", hint: "biology, genetics, ecology as a science; not clinical medicine" },
  { key: "earth_science", label: "Earth science", group: "science", hint: "geology, oceanography, meteorology, planetary science" },
  { key: "cognitive_science", label: "Cognitive science", group: "science", hint: "neuroscience, psychology as research, linguistics" },
  { key: "research_practice", label: "Research practice", group: "science", hint: "how research itself works: methodology, peer review, reproducibility, funding" },

  // technology
  { key: "software_engineering", label: "Software engineering", group: "technology", hint: "programming, languages, tooling, architecture, developer practice" },
  { key: "artificial_intelligence", label: "Artificial intelligence", group: "technology", hint: "machine learning, models, AI systems and their capabilities" },
  { key: "computer_systems", label: "Computer systems", group: "technology", hint: "operating systems, networking, databases, distributed systems, hardware" },
  { key: "security_privacy", label: "Security and privacy", group: "technology", hint: "security research, cryptography, surveillance, data protection" },
  { key: "robotics_hardware", label: "Robotics and hardware", group: "technology", hint: "robotics, embedded systems, electronics, manufacturing technology" },
  { key: "space_technology", label: "Space technology", group: "technology", hint: "launch, satellites, spaceflight engineering and industry" },
  { key: "biotechnology", label: "Biotechnology", group: "technology", hint: "applied biotech, bioengineering, pharma R&D as an industry" },

  // health
  { key: "medicine", label: "Medicine", group: "health", hint: "clinical medicine, disease, treatment, medical research outcomes" },
  { key: "public_health", label: "Public health", group: "health", hint: "epidemiology, health policy, health systems" },
  { key: "nutrition_fitness", label: "Nutrition and fitness", group: "health", hint: "diet, exercise, sleep, everyday physical health" },
  { key: "mental_health", label: "Mental health", group: "health", hint: "mental health, therapy, wellbeing as lived experience" },

  // society
  { key: "politics_governance", label: "Politics and governance", group: "society", hint: "government, elections, public administration, political conflict" },
  { key: "law_justice", label: "Law and justice", group: "society", hint: "law, courts, regulation, civil liberties, crime" },
  { key: "international_affairs", label: "International affairs", group: "society", hint: "geopolitics, diplomacy, war, international institutions" },
  { key: "education", label: "Education", group: "society", hint: "schooling, universities, pedagogy, learning as an institution" },
  { key: "media_information", label: "Media and information", group: "society", hint: "journalism, platforms, misinformation, the information ecosystem" },
  { key: "social_dynamics", label: "Social dynamics", group: "society", hint: "sociology, demography, inequality, community, migration" },
  { key: "labor_work", label: "Labor and work", group: "society", hint: "employment, careers, unions, workplace and the nature of work" },

  // economy
  { key: "economics", label: "Economics", group: "economy", hint: "macroeconomics, trade, monetary policy, economic theory" },
  { key: "business_industry", label: "Business and industry", group: "economy", hint: "companies, strategy, industry structure, management" },
  { key: "finance_markets", label: "Finance and markets", group: "economy", hint: "investing, markets, banking, personal finance" },
  { key: "startups_venture", label: "Startups and venture", group: "economy", hint: "founding companies, venture funding, product-market fit" },
  { key: "energy", label: "Energy", group: "economy", hint: "energy production, grids, oil and gas, renewables as an industry" },
  { key: "transport_logistics", label: "Transport and logistics", group: "economy", hint: "mobility, shipping, supply chains, infrastructure" },
  { key: "agriculture_food", label: "Agriculture and food", group: "economy", hint: "farming, food systems, food industry" },

  // culture
  { key: "history", label: "History", group: "culture", hint: "historical events, historiography, archaeology" },
  { key: "philosophy", label: "Philosophy", group: "culture", hint: "philosophy, ethics, logic, theory of knowledge" },
  { key: "religion_belief", label: "Religion and belief", group: "culture", hint: "religions, spiritual practice, belief systems" },
  { key: "literature_writing", label: "Literature and writing", group: "culture", hint: "books, fiction, poetry, the craft of writing" },
  { key: "visual_arts", label: "Visual arts", group: "culture", hint: "art, photography, illustration, architecture as art" },
  { key: "music_audio", label: "Music and audio", group: "culture", hint: "music, musicians, audio culture" },
  { key: "film_television", label: "Film and television", group: "culture", hint: "cinema, TV, streaming, screen storytelling" },
  { key: "games", label: "Games", group: "culture", hint: "video games, board games, game design, play" },
  { key: "sports", label: "Sports", group: "culture", hint: "competitive sport, athletes, sporting events" },
  { key: "design", label: "Design", group: "culture", hint: "product, graphic, interaction and industrial design" },
  { key: "language_translation", label: "Language and translation", group: "culture", hint: "learning languages, translation, writing systems" },

  // environment
  { key: "climate", label: "Climate", group: "environment", hint: "climate change, climate science impacts, decarbonization" },
  { key: "conservation", label: "Conservation", group: "environment", hint: "biodiversity, habitats, animals, environmental protection" },
  { key: "urbanism", label: "Urbanism", group: "environment", hint: "cities, housing, planning, built environment" },

  // practice
  { key: "craft_making", label: "Craft and making", group: "practice", hint: "woodworking, textiles, repair, hands-on making, DIY" },
  { key: "cooking", label: "Cooking", group: "practice", hint: "recipes, technique, home cooking and eating" },
  { key: "travel_places", label: "Travel and places", group: "practice", hint: "travel, geography as experience, particular places" },
  { key: "outdoors", label: "Outdoors", group: "practice", hint: "hiking, climbing, nature as recreation, gardening" },
  { key: "home_living", label: "Home and living", group: "practice", hint: "domestic life, home organization, family logistics" },
  { key: "personal_productivity", label: "Personal productivity", group: "practice", hint: "habits, note-taking, planning, tools for thought" },
  { key: "parenting_relationships", label: "Parenting and relationships", group: "practice", hint: "raising children, friendship, partnership, caregiving" },
];

export function registerBuiltinDomains(): void {
  for (const domain of BUILTIN_DOMAINS) registerDomain({ ...domain, owner: "sourceAnnotation" });
}

registerBuiltinDomains();
