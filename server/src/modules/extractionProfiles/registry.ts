import { registerAcademicExtractionProfiles } from "../academic/extractionProfile";
import { registerDocumentExtractionProfiles } from "../sources/documentExtractionProfile";
import type { Queryable } from "../routeUtils/common";

export interface ExtractionProfileMaterializationInput {
  spaceId: string;
  sourceItemId: string;
  projectId: string;
}

export interface ExtractionProfileMaterializationResult {
  objectId: string;
  created: boolean;
}

export type ExtractionProfileMaterializer = (
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
) => Promise<ExtractionProfileMaterializationResult | null>;

export interface ExtractionProfileEntry {
  key: string;
  displayName: string;
  /**
   * What kind of material this profile produces, for logs and diagnostics.
   *
   * Deliberately *not* an ontology entity type: every profile materializes a
   * `space_objects` subtype the ontology registry already declares (both current
   * members produce `source`), and what differs between them is the extension
   * they attach — `academic_papers` for one, nothing for the other. Reading this
   * as an entity name would suggest `document` is a registered type; it is not.
   */
  entityType: string;
  /** Used when a binding does not request a domain-specific profile. Exactly
   * one registered profile must declare this fallback. */
  defaultForUnspecified?: boolean;
  /** Optional graph presentation contributed by this domain edge. */
  graphLensId?: string;
  /**
   * Domain-specific screening criteria this profile understands (R4/D12).
   *
   * `methods` is meaningful when screening papers and meaningless when screening
   * web pages, so it cannot be a column on a shared table — but it also must not
   * become an unconstrained bag, or the criteria table turns into free-form JSON
   * nobody can validate. The profile that knows the domain declares its legal
   * keys, and `domain_criteria_json` accepts exactly those.
   */
  domainCriteriaKeys?: readonly string[];
  materializer: ExtractionProfileMaterializer;
}

const PROFILE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export class ExtractionProfileRegistry {
  private readonly entries = new Map<string, ExtractionProfileEntry>();

  register(entry: ExtractionProfileEntry): void {
    if (!PROFILE_KEY_PATTERN.test(entry.key)) {
      throw new Error(`invalid extraction profile key ${JSON.stringify(entry.key)}`);
    }
    if (!entry.entityType.trim()) throw new Error("entityType must be non-empty");
    if (!entry.displayName.trim()) throw new Error("displayName must be non-empty");
    if (this.entries.has(entry.key)) {
      throw new Error(`an extraction profile is already registered for key ${entry.key}`);
    }
    this.entries.set(entry.key, entry);
  }

  get(key: string): ExtractionProfileEntry | null {
    return this.entries.get(key) ?? null;
  }

  registeredKeys(): ReadonlySet<string> {
    return new Set(this.entries.keys());
  }

  entriesList(): readonly ExtractionProfileEntry[] {
    return [...this.entries.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  defaultKey(): string {
    const defaults = this.entriesList().filter((entry) => entry.defaultForUnspecified);
    if (defaults.length !== 1) {
      throw new Error(`extraction profile registry requires exactly one default; found ${defaults.length}`);
    }
    return defaults[0]!.key;
  }

  /** The union of domain criteria keys the named profiles declare. */
  domainCriteriaKeysFor(profileKeys: Iterable<string>): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const profileKey of profileKeys) {
      for (const key of this.get(profileKey)?.domainCriteriaKeys ?? []) keys.add(key);
    }
    return keys;
  }

  async materialize(
    key: string,
    db: Queryable,
    input: ExtractionProfileMaterializationInput,
  ): Promise<ExtractionProfileMaterializationResult | null> {
    const entry = this.get(key);
    if (!entry) return null;
    if (!input.projectId?.trim()) {
      throw new Error("extraction profile materialization requires projectId");
    }
    return entry.materializer(db, input);
  }
}

export function createDefaultExtractionProfileRegistry(): ExtractionProfileRegistry {
  const registry = new ExtractionProfileRegistry();
  registerAcademicExtractionProfiles(registry);
  registerDocumentExtractionProfiles(registry);
  return registry;
}

export const defaultExtractionProfileRegistry = createDefaultExtractionProfileRegistry();
