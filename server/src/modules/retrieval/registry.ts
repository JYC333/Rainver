import type { Queryable } from "../routeUtils/common.js";
import type {
  CanonicalObject,
  RetrievalEdge,
  RetrievalObjectRef,
  RetrievalObjectType,
  RevalidatedObject,
} from "./types.js";

/**
 * A domain plugs into the generic zero-LLM retrieval engine by registering an
 * adapter. The adapter owns everything domain-specific: which object types it
 * indexes, how to load a canonical object for projection, how to revalidate
 * visibility (and any domain-specific access auditing), and which domain edges
 * to derive. The engine owns the generic substrate: aliases, chunks, extracted
 * links, search arms, fusion, and evidence.
 *
 * This is the seam that lets Knowledge be the first consumer while Memory (or
 * any later domain) can register its own adapter without forking the engine.
 */
export interface RetrievalDomainAdapter {
  readonly objectTypes: readonly RetrievalObjectType[];

  /**
   * Load the canonical object as a projectable shape, or null when it should not
   * be indexed (missing, archived, superseded, deleted). Null tells the engine
   * to drop any existing projection for the object.
   */
  loadCanonical(
    db: Queryable,
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
  ): Promise<CanonicalObject | null>;

  /**
   * Confirm the viewer may read the canonical object right now and return its
   * authoritative title/snippet text, or null to drop the candidate. This is the
   * single visibility gate for search results; the engine never trusts the
   * derived projection for read access.
   */
  revalidate(
    db: Queryable,
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
    viewerUserId: string,
  ): Promise<RevalidatedObject | null>;

  /**
   * Batched form of `revalidate`. Adapters that implement it should return only
   * objects the viewer can read; omitted ids are treated as not readable. The
   * engine falls back to the scalar form for adapters that do not provide a
   * batch implementation.
   */
  revalidateMany?(
    db: Queryable,
    spaceId: string,
    objectType: RetrievalObjectType,
    objectIds: readonly string[],
    viewerUserId: string,
  ): Promise<Map<string, RevalidatedObject>>;

  /** Domain-specific derived edges (relations, links) for a projected object. */
  projectEdges?(
    db: Queryable,
    spaceId: string,
    object: CanonicalObject,
  ): Promise<RetrievalEdge[]>;

  /** Enumerate every indexable object in a space, for full rebuilds/backfill. */
  listObjectIds(db: Queryable, spaceId: string): Promise<RetrievalObjectRef[]>;
}

export class RetrievalRegistry {
  private readonly byType = new Map<RetrievalObjectType, RetrievalDomainAdapter>();

  register(adapter: RetrievalDomainAdapter): void {
    if (!adapter.objectTypes.length) throw new Error("retrieval adapter declares no object types");
    for (const objectType of adapter.objectTypes) {
      if (this.byType.has(objectType)) {
        throw new Error(`a retrieval adapter is already registered for object type ${objectType}`);
      }
      this.byType.set(objectType, adapter);
    }
  }

  adapterFor(objectType: RetrievalObjectType): RetrievalDomainAdapter | undefined {
    return this.byType.get(objectType);
  }

  objectTypes(): RetrievalObjectType[] {
    return [...this.byType.keys()];
  }

  adapters(): RetrievalDomainAdapter[] {
    return [...new Set(this.byType.values())];
  }
}
